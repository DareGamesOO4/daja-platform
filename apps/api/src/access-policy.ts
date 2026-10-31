import type pg from 'pg';
import type { RequestContext } from '@daja/shared';
import {
  PermissionDeniedError,
  ResourceNotFoundError,
  ValidationFailedError
} from '@daja/security';

type Client = Pick<pg.PoolClient, 'query'>;

export function requireScopedPermission(
  ctx: RequestContext,
  permissions: string[],
  locationId?: string
): void {
  if (ctx.isOwner) return;
  if (
    !permissions.some(
      (permission) =>
        ctx.permissions.includes(permission) &&
        ctx.scopedGrants?.some(
          (grant) =>
            grant.permission === permission &&
            (grant.scope === 'all_locations' ||
              (locationId !== undefined && grant.locationId === locationId))
        )
    )
  )
    throw new PermissionDeniedError(permissions[0]!);
}

// Access changes are serialized per organization, including the last-owner check.
export async function lockAccessPolicy(client: Client, ctx: RequestContext): Promise<void> {
  await client.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [ctx.organizationId]);
}

export async function grantableRole(
  client: Client,
  ctx: RequestContext,
  roleId: string,
  mutable = false
) {
  const result = await client.query<{ code: string | null }>(
    'SELECT code FROM roles WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL FOR UPDATE',
    [roleId, ctx.organizationId]
  );
  const role = result.rows[0];
  if (!role) throw new ResourceNotFoundError('role');
  if (role.code === 'owner' && (mutable || !ctx.isOwner))
    throw new PermissionDeniedError('owner.protected');
  const permissions = await client.query<{ permission_id: string }>(
    'SELECT permission_id FROM role_permissions WHERE role_id = $1',
    [roleId]
  );
  assertGrantablePermissions(
    ctx,
    permissions.rows.map((row) => row.permission_id)
  );
  return role;
}

export function assertGrantablePermissions(ctx: RequestContext, permissions: string[]): void {
  if (
    !ctx.isOwner &&
    permissions.some(
      (permission) =>
        !ctx.scopedGrants?.some(
          (grant) => grant.permission === permission && grant.scope === 'all_locations'
        )
    )
  )
    throw new PermissionDeniedError('access.grant_subset');
}

export async function manageableUser(
  client: Client,
  ctx: RequestContext,
  userId: string
): Promise<void> {
  const result = await client.query(
    'SELECT id FROM users WHERE id = $1 AND organization_id = $2 FOR UPDATE',
    [userId, ctx.organizationId]
  );
  if (!result.rowCount) throw new ResourceNotFoundError('user');
  if (ctx.isOwner) return;
  const assignments = await client.query<{
    role_id: string;
    scope: string;
    location_id: string | null;
  }>(
    'SELECT role_id, scope, location_id FROM user_role_assignments WHERE organization_id = $1 AND user_id = $2 AND deleted_at IS NULL',
    [ctx.organizationId, userId]
  );
  for (const assignment of assignments.rows) {
    if (assignment.scope !== 'location' || !assignment.location_id)
      throw new PermissionDeniedError('users.scope');
    await assignableLocation(client, ctx, assignment.location_id);
    await grantableRole(client, ctx, assignment.role_id);
  }
}

export async function assignableLocation(
  client: Client,
  ctx: RequestContext,
  locationId: string
): Promise<void> {
  const result = await client.query(
    'SELECT id FROM locations WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
    [locationId, ctx.organizationId]
  );
  if (!result.rowCount) throw new ResourceNotFoundError('location');
  if (
    !ctx.isOwner &&
    !ctx.scopedGrants?.some(
      (grant) =>
        ['users.create', 'users.update', 'admin.users'].includes(grant.permission) &&
        (grant.scope === 'all_locations' || grant.locationId === locationId)
    )
  )
    throw new PermissionDeniedError('users.scope');
}

export async function requireActiveOwner(client: Client, ctx: RequestContext): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM users u
    JOIN user_role_assignments a ON a.user_id = u.id AND a.organization_id = u.organization_id AND a.deleted_at IS NULL
    JOIN roles r ON r.id = a.role_id AND r.organization_id = a.organization_id AND r.deleted_at IS NULL
    WHERE u.organization_id = $1 AND u.active AND r.code = 'owner' LIMIT 1`,
    [ctx.organizationId]
  );
  if (!result.rowCount) {
    const previous = await client.query(
      `SELECT 1 FROM user_role_assignments a
      JOIN roles r ON r.id = a.role_id AND r.organization_id = a.organization_id
      WHERE a.organization_id = $1 AND r.code = 'owner' LIMIT 1`,
      [ctx.organizationId]
    );
    if (previous.rowCount)
      throw new ValidationFailedError('The organization must retain an active owner.');
  }
}
