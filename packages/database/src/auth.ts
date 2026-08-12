import type pg from 'pg';
import type { QueryResultRow } from 'pg';
import {
  InvalidCredentialsError,
  InvalidTokenError,
  TenantAccessDeniedError
} from '@daja/security';

export interface StaffPrincipal {
  userId: string;
  organizationId: string;
  email: string;
  displayName: string;
  active: boolean;
  deviceId: string;
  sessionFamilyId: string;
  sessionId?: string;
  roles: string[];
  permissions: string[];
}

export interface StaffUserForLogin {
  id: string;
  organizationId: string;
  email: string;
  displayName: string;
  passwordHash: string;
  active: boolean;
}

export interface DeviceSessionRecord {
  id: string;
  familyId: string;
  organizationId: string;
  userId: string;
  deviceId: string;
  refreshTokenHash: string | null;
  refreshJti: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

export class AuthRepository {
  constructor(private readonly client: Pick<pg.Pool | pg.PoolClient, 'query'>) {}

  async findStaffUserForLogin(input: {
    organizationId: string;
    email: string;
  }): Promise<StaffUserForLogin | null> {
    const result = await this.client.query<StaffUserRow>(
      `SELECT id, organization_id, email, display_name, password_hash, active
       FROM users
       WHERE organization_id = $1 AND normalized_email = lower($2)`,
      [input.organizationId, input.email]
    );
    const row = result.rows[0];
    if (!row || !row.password_hash) {
      return null;
    }
    return {
      id: row.id,
      organizationId: row.organization_id,
      email: row.email,
      displayName: row.display_name,
      passwordHash: row.password_hash,
      active: row.active
    };
  }

  async ensureLoginDevice(input: {
    organizationId: string;
    userId: string;
    deviceId: string;
    offlineAuthorizationExpiresAt: Date;
  }): Promise<void> {
    try {
      await this.client.query(
        `INSERT INTO devices (
           id, organization_id, user_id, device_key, display_name, device_type,
           active, offline_authorization_expires_at, last_seen_at, metadata
         )
         VALUES ($1::uuid, $2, $3, $1::text, 'RFIDDaja device', 'rfiddaja_desktop', true, $4, now(), '{}'::jsonb)
         ON CONFLICT (id)
         DO UPDATE SET
           user_id = EXCLUDED.user_id,
           active = true,
           revoked_at = NULL,
           deleted_at = NULL,
           offline_authorization_expires_at = EXCLUDED.offline_authorization_expires_at,
           last_seen_at = now(),
           updated_at = now()`,
        [input.deviceId, input.organizationId, input.userId, input.offlineAuthorizationExpiresAt]
      );
    } catch (error) {
      if (isPgError(error, '23505')) {
        throw new TenantAccessDeniedError();
      }
      throw error;
    }
  }

  async createSession(input: {
    organizationId: string;
    userId: string;
    deviceId: string;
    familyId: string;
    refreshTokenHash: string;
    refreshJti: string;
    expiresAt: Date;
    ipHash?: string | null;
    userAgentHash?: string | null;
  }): Promise<DeviceSessionRecord> {
    const result = await this.client.query<DeviceSessionRow>(
      `INSERT INTO device_sessions (
         organization_id, user_id, device_id, family_id, refresh_token_hash, refresh_jti,
         expires_at, ip_hash, user_agent_hash
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, family_id, organization_id, user_id, device_id, refresh_token_hash,
                 refresh_jti, expires_at, revoked_at`,
      [
        input.organizationId,
        input.userId,
        input.deviceId,
        input.familyId,
        input.refreshTokenHash,
        input.refreshJti,
        input.expiresAt,
        input.ipHash ?? null,
        input.userAgentHash ?? null
      ]
    );
    return mapSession(requireRow(result));
  }

  async rotateRefreshSession(input: {
    sessionId: string;
    replacementRefreshTokenHash: string;
    replacementRefreshJti: string;
    expiresAt: Date;
  }): Promise<DeviceSessionRecord> {
    const current = await this.client.query<DeviceSessionRow>(
      `SELECT id, family_id, organization_id, user_id, device_id, refresh_token_hash,
              refresh_jti, expires_at, revoked_at
       FROM device_sessions
       WHERE id = $1
       FOR UPDATE`,
      [input.sessionId]
    );
    const currentSession = mapSession(requireRow(current));
    if (currentSession.revokedAt || currentSession.expiresAt <= new Date()) {
      await this.revokeSessionFamily(
        currentSession.organizationId,
        currentSession.familyId,
        'refresh_reuse_or_expired_session'
      );
      throw new InvalidTokenError();
    }
    const replacement = await this.createSession({
      organizationId: currentSession.organizationId,
      userId: currentSession.userId,
      deviceId: currentSession.deviceId,
      familyId: currentSession.familyId,
      refreshTokenHash: input.replacementRefreshTokenHash,
      refreshJti: input.replacementRefreshJti,
      expiresAt: input.expiresAt
    });
    await this.client.query(
      `UPDATE device_sessions
       SET revoked_at = now(), revoked_reason = 'rotated', replaced_by_session_id = $2
       WHERE id = $1`,
      [currentSession.id, replacement.id]
    );
    return replacement;
  }

  async findActiveRefreshSession(input: {
    organizationId: string;
    userId: string;
    deviceId: string;
    familyId: string;
    refreshJti: string;
    refreshTokenHash: string;
  }): Promise<DeviceSessionRecord> {
    const result = await this.client.query<DeviceSessionRow>(
      `SELECT id, family_id, organization_id, user_id, device_id, refresh_token_hash,
              refresh_jti, expires_at, revoked_at
       FROM device_sessions
       WHERE organization_id = $1 AND user_id = $2 AND device_id = $3 AND family_id = $4
         AND refresh_jti = $5
       FOR UPDATE`,
      [input.organizationId, input.userId, input.deviceId, input.familyId, input.refreshJti]
    );
    const session = result.rows[0] ? mapSession(result.rows[0]) : null;
    if (!session || session.refreshTokenHash !== input.refreshTokenHash) {
      await this.revokeSessionFamily(
        input.organizationId,
        input.familyId,
        'refresh_reuse_detected'
      );
      throw new InvalidTokenError();
    }
    if (session.revokedAt || session.expiresAt <= new Date()) {
      await this.revokeSessionFamily(
        input.organizationId,
        input.familyId,
        'refresh_reuse_or_expired_session'
      );
      throw new InvalidTokenError();
    }
    return session;
  }

  async revokeSessionFamily(
    organizationId: string,
    familyId: string,
    reason: string
  ): Promise<void> {
    await this.client.query(
      `UPDATE device_sessions
       SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = $3
       WHERE organization_id = $1 AND family_id = $2 AND revoked_at IS NULL`,
      [organizationId, familyId, reason]
    );
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.client.query(
      `UPDATE device_sessions
       SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = $2
       WHERE id = $1`,
      [sessionId, reason]
    );
  }

  async buildPrincipal(input: {
    organizationId: string;
    userId: string;
    deviceId: string;
    sessionFamilyId: string;
    sessionId?: string;
  }): Promise<StaffPrincipal> {
    const user = await this.client.query<StaffUserRow>(
      `SELECT id, organization_id, email, display_name, password_hash, active
       FROM users
       WHERE organization_id = $1 AND id = $2`,
      [input.organizationId, input.userId]
    );
    const row = user.rows[0];
    if (!row || !row.active) {
      throw new InvalidCredentialsError();
    }
    const device = await this.client.query(
      `UPDATE devices
       SET last_seen_at = now(), updated_at = now()
       WHERE id = $1 AND organization_id = $2 AND user_id = $3
         AND active AND revoked_at IS NULL AND deleted_at IS NULL`,
      [input.deviceId, input.organizationId, input.userId]
    );
    if (device.rowCount !== 1) {
      throw new TenantAccessDeniedError();
    }
    const grants = await this.client.query<{ role: string; permission: string | null }>(
      `SELECT r.name AS role, rp.permission_id AS permission
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id AND r.organization_id = $2
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       WHERE ur.user_id = $1
       ORDER BY r.name, rp.permission_id`,
      [input.userId, input.organizationId]
    );
    return {
      userId: row.id,
      organizationId: row.organization_id,
      email: row.email,
      displayName: row.display_name,
      active: row.active,
      deviceId: input.deviceId,
      sessionFamilyId: input.sessionFamilyId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      roles: [...new Set(grants.rows.map((grant) => grant.role))],
      permissions: [
        ...new Set(
          grants.rows.map((grant) => grant.permission).filter((value): value is string => !!value)
        )
      ]
    };
  }

  async assertAccessSession(input: {
    organizationId: string;
    userId: string;
    deviceId: string;
    familyId: string;
    sessionId: string;
  }): Promise<void> {
    const result = await this.client.query(
      `SELECT 1
       FROM device_sessions
       WHERE id = $5 AND organization_id = $1 AND user_id = $2 AND device_id = $3
         AND family_id = $4 AND revoked_at IS NULL AND expires_at > now()`,
      [input.organizationId, input.userId, input.deviceId, input.familyId, input.sessionId]
    );
    if (result.rowCount !== 1) {
      throw new InvalidTokenError();
    }
  }

  async assertLocationAccess(input: {
    organizationId: string;
    userId: string;
    locationId: string;
  }): Promise<void> {
    const result = await this.client.query(
      `SELECT 1
       FROM locations l
       WHERE l.id = $3 AND l.organization_id = $1 AND l.active AND l.deleted_at IS NULL
         AND (
           EXISTS (
             SELECT 1 FROM user_location_assignments ula
             WHERE ula.user_id = $2 AND ula.location_id = l.id
           )
           OR NOT EXISTS (
             SELECT 1 FROM user_location_assignments ula_any
             WHERE ula_any.user_id = $2
           )
         )`,
      [input.organizationId, input.userId, input.locationId]
    );
    if (result.rowCount !== 1) {
      throw new TenantAccessDeniedError();
    }
  }

  async auditAuthEvent(input: {
    organizationId: string;
    userId: string;
    deviceId: string;
    sessionId: string;
    operation: string;
    requestId: string;
    correlationId: string;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO audit_events (
         organization_id, actor_user_id, device_id, aggregate_type, aggregate_id,
         operation, after_payload, correlation_id, request_id
       )
       VALUES ($1, $2, $3, 'auth_session', $4, $5, $6::jsonb, $7, $8)`,
      [
        input.organizationId,
        input.userId,
        input.deviceId,
        input.sessionId,
        input.operation,
        JSON.stringify(input.payload ?? {}),
        input.correlationId,
        input.requestId
      ]
    );
  }
}

interface StaffUserRow {
  id: string;
  organization_id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  active: boolean;
}

interface DeviceSessionRow {
  id: string;
  family_id: string;
  organization_id: string;
  user_id: string;
  device_id: string;
  refresh_token_hash: string | null;
  refresh_jti: string | null;
  expires_at: Date;
  revoked_at: Date | null;
}

function mapSession(row: DeviceSessionRow): DeviceSessionRecord {
  return {
    id: row.id,
    familyId: row.family_id,
    organizationId: row.organization_id,
    userId: row.user_id,
    deviceId: row.device_id,
    refreshTokenHash: row.refresh_token_hash,
    refreshJti: row.refresh_jti,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at
  };
}

function requireRow<T extends QueryResultRow>(result: pg.QueryResult<T>): T {
  const row = result.rows[0];
  if (!row) {
    throw new InvalidTokenError();
  }
  return row;
}

function isPgError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
