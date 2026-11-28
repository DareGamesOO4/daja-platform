import { Body, Controller, Get, Inject, Param, Post, Query, Req, ServiceUnavailableException } from '@nestjs/common';
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import type { AppConfig } from '@daja/config';
import type { Database, DbClient } from '@daja/database';
import { requirePermission, PermissionDeniedError, ValidationFailedError } from '@daja/security';
import { AuthRepository } from '@daja/database';
import { parseWithSchema, uuidSchema } from '@daja/validation';
import { requireScopedPermission } from './access-policy.js';
import { CONFIG, DATABASE } from './tokens.js';
import { resolveRequestContext } from './runtime/request-context.js';
import type { RequestContext } from '@daja/shared';

const createSchema = z.object({
  locationId: z.string().uuid(),
  zoneIds: z.array(z.string().uuid()).max(200).optional(),
  expiresAt: z.string().datetime().optional(),
  deviceId: z.string().uuid(),
  userId: z.string().uuid(),
  permissionsHash: z.string().min(1).max(256),
  policyVersion: z.number().int().positive()
});
const mobileScopeSchema = z.object({
  locationId: uuidSchema,
  zoneId: uuidSchema.optional(),
  binId: uuidSchema.optional()
});
const uploadSchema = z
  .object({
    countSessionId: z.string().uuid(),
    packageId: z.string().uuid(),
    baselineServerRevision: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(1).max(240),
    observations: z
      .array(
        z
          .object({
            epc: z.string().regex(/^(?:[0-9a-fA-F]{2}){4,64}$/),
            classification: z.string().max(64),
            firstSeenAt: z.string().datetime(),
            lastSeenAt: z.string().datetime(),
            rawReadCount: z.number().int().positive()
          })
          .passthrough()
      )
      .max(5000),
    summary: z.record(z.string(), z.unknown())
  })
  .passthrough();
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item
  );
}
function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

@Controller('offline-inventory')
export class OfflineInventoryController {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CONFIG) private readonly config: AppConfig
  ) {}

  @Get('mobile-baseline')
  async mobileBaseline(@Req() request: Request, @Query() query: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'sync.read');
    return this.loadMobileBaseline(ctx, parseWithSchema(mobileScopeSchema, query));
  }

  @Post('mobile-reserve')
  async mobileReserve(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'sync.read');
    if (!ctx.deviceId) throw new PermissionDeniedError('offline.identity');
    const input = parseWithSchema(z.object({ locationId: uuidSchema.optional() }).strict(), body);
    const makeReserve = this.mobileReserveSigner(ctx);
    const baseline = input.locationId ? await this.loadMobileBaseline(ctx, { locationId: input.locationId }) : null;
    return makeReserve(baseline);
  }

  @Post('mobile-reserve/batch')
  async mobileReserveBatch(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'sync.read');
    if (!ctx.deviceId) throw new PermissionDeniedError('offline.identity');
    const input = parseWithSchema(z.object({
      includePermit: z.boolean(),
      locationIds: z.array(uuidSchema).max(10)
    }).strict(), body);
    const makeReserve = this.mobileReserveSigner(ctx);
    const locations = [];
    for (const locationId of new Set(input.locationIds)) {
      const baseline = await this.loadMobileBaseline(ctx, { locationId });
      locations.push({ locationId, reserve: makeReserve(baseline) });
    }
    return { permit: input.includePermit ? makeReserve(null) : null, locations };
  }

  private mobileReserveSigner(ctx: RequestContext) {
    const configuredKey = this.config.OFFLINE_PACKAGE_SIGNING_PRIVATE_KEY || this.config.OFFLINE_LEASE_SIGNING_PRIVATE_KEY;
    if (!configuredKey) throw new ServiceUnavailableException('Mobile offline signing is not configured.');
    const key = createPrivateKey(configuredKey.replace(/\\n/g, '\n'));
    const verificationKey = createPublicKey(key).export({ format: 'jwk' }).x;
    if (key.asymmetricKeyType !== 'ed25519' || !verificationKey) {
      throw new ServiceUnavailableException('Mobile offline signing requires Ed25519.');
    }
    return (baseline: unknown) => {
      const issuedAt = Date.now();
      const payload = Buffer.from(JSON.stringify({
        schemaVersion: 2,
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        deviceId: ctx.deviceId,
        policyVersion: ctx.policyVersion ?? 1,
        issuedAt: new Date(issuedAt).toISOString(),
        expiresAt: new Date(issuedAt + 24 * 3600_000).toISOString(),
        baseline
      }));
      return {
        payload: payload.toString('base64url'),
        signature: sign(null, payload, key).toString('base64url'),
        verificationKey
      };
    };
  }

  private async loadMobileBaseline(ctx: RequestContext, scope: z.infer<typeof mobileScopeSchema>) {
    requireScopedPermission(ctx, ['rfid_counts.sync'], scope.locationId);
    await new AuthRepository(this.database.pool).assertLocationAccess({
      organizationId: ctx.organizationId, userId: ctx.userId, locationId: scope.locationId
    });
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const revision = await client.query<{ current_revision: string }>(
        'SELECT current_revision FROM organization_revisions WHERE organization_id=$1', [ctx.organizationId]
      );
      const expectedTags = await this.mobileExpectedTags(client, ctx.organizationId, scope);
      await client.query('COMMIT');
      return {
        locationId: scope.locationId,
        baselineServerRevision: Number(revision.rows[0]?.current_revision ?? 0),
        expectedTags
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private async mobileExpectedTags(client: DbClient, organizationId: string, scope: z.infer<typeof mobileScopeSchema>) {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT t.id AS "tagId", t.epc, COALESCE(t.variant_id,i.variant_id) AS "productVariantId", v.sku,
              COALESCE(v.name,p.name) AS "displayName", v.barcode, $2::uuid AS "expectedLocationId",
              COALESCE(bin.zone_id, i.current_zone_id) AS "expectedZoneId", COALESCE(bin.id,i.current_bin_id) AS "expectedBinId"
       FROM rfid_tags t
       LEFT JOIN inventory_items i ON i.organization_id=t.organization_id AND i.id=t.inventory_item_id AND i.deleted_at IS NULL
       LEFT JOIN product_variants v ON v.organization_id=t.organization_id AND v.id=COALESCE(t.variant_id,i.variant_id)
       LEFT JOIN products p ON p.organization_id=t.organization_id AND p.id=v.product_id
       LEFT JOIN LATERAL (
         SELECT id, location_id, metadata->>'binId' AS bin_id
         FROM rfid_tag_events WHERE organization_id=t.organization_id AND tag_id=t.id
           AND event_type IN ('assigned','moved','returned')
         ORDER BY occurred_at DESC,id DESC LIMIT 1
       ) placement ON true
       LEFT JOIN warehouse_bins bin ON bin.organization_id=t.organization_id AND bin.deleted_at IS NULL
         AND bin.id = CASE WHEN placement.bin_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN placement.bin_id::uuid ELSE i.current_bin_id END
       WHERE t.organization_id=$1 AND t.deleted_at IS NULL AND t.status NOT IN ('retired','sold','lost')
         AND v.deleted_at IS NULL AND p.deleted_at IS NULL
         AND CASE WHEN placement.id IS NULL THEN i.current_location_id ELSE placement.location_id END=$2::uuid
         AND ($3::uuid IS NULL OR COALESCE(bin.zone_id,i.current_zone_id)=$3)
         AND ($4::uuid IS NULL OR COALESCE(bin.id,i.current_bin_id)=$4)
       ORDER BY t.epc`, [organizationId, scope.locationId, scope.zoneId ?? null, scope.binId ?? null]
    );
    return rows;
  }

  @Post('packages') async create(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'sync.write');
    const input = parseWithSchema(createSchema, body);
    requireScopedPermission(ctx, ['rfid_counts.create', 'rfid_counts.sync'], input.locationId);
    if (input.userId !== ctx.userId || input.deviceId !== ctx.deviceId)
      throw new PermissionDeniedError('offline.identity');
    await new AuthRepository(this.database.pool).assertLocationAccess({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      locationId: input.locationId
    });
    const expiry = input.expiresAt
      ? new Date(input.expiresAt)
      : new Date(Date.now() + 8 * 3600_000);
    if (expiry.getTime() <= Date.now() || expiry.getTime() > Date.now() + 8 * 3600_000)
      throw new ValidationFailedError('Offline authorization must expire within eight hours.');
    input.expiresAt = expiry.toISOString();
    input.policyVersion = ctx.policyVersion ?? 1;
    input.permissionsHash = hash({
      permissions: [...ctx.permissions].sort(),
      grants: ctx.scopedGrants ?? []
    });
    if (input.zoneIds?.length) {
      const zones = await this.database.pool.query(
        `SELECT z.id FROM warehouse_zones z JOIN warehouses w ON w.id=z.warehouse_id AND w.organization_id=z.organization_id WHERE z.organization_id=$1 AND w.location_id=$2 AND z.id=ANY($3::uuid[]) AND z.deleted_at IS NULL AND w.deleted_at IS NULL`,
        [ctx.organizationId, input.locationId, input.zoneIds]
      );
      if (zones.rowCount !== new Set(input.zoneIds).size)
        throw new PermissionDeniedError('offline.zone');
    }
    if (
      !this.config.OFFLINE_PACKAGE_SIGNING_PRIVATE_KEY ||
      !this.config.OFFLINE_LEASE_SIGNING_PRIVATE_KEY
    )
      throw new Error('Offline signing keys are not configured.');
    const revision = await this.database.pool.query<{ current_revision: string }>(
      'SELECT current_revision FROM organization_revisions WHERE organization_id = $1',
      [ctx.organizationId]
    );
    const tags = await this.database.pool.query<Record<string, unknown>>(
      `SELECT t.id AS "tagId", t.epc, t.tid, COALESCE(t.variant_id, i.variant_id) AS "productVariantId", COALESCE(v.sku, '') AS sku, COALESCE(v.name, p.name) AS "displayName", v.barcode, i.current_location_id AS "expectedLocationId", i.current_zone_id AS "expectedZoneId", i.current_bin_id AS "expectedBinId", t.status, t.version AS "baselineTagVersion" FROM rfid_tags t LEFT JOIN inventory_items i ON i.id = t.inventory_item_id LEFT JOIN product_variants v ON v.id = COALESCE(t.variant_id, i.variant_id) LEFT JOIN products p ON p.id = v.product_id WHERE t.organization_id = $1 AND t.deleted_at IS NULL AND i.deleted_at IS NULL AND v.deleted_at IS NULL AND p.deleted_at IS NULL AND i.current_location_id = $2 AND ($3::uuid[] IS NULL OR i.current_zone_id=ANY($3::uuid[]))`,
      [ctx.organizationId, input.locationId, input.zoneIds?.length ? input.zoneIds : null]
    );
    const expectedTags = tags.rows;
    const packageId = randomUUID();
    const now = new Date().toISOString();
    const baselineServerRevision = Number(revision.rows[0]?.current_revision ?? 0);
    const leasePayload = {
      userId: input.userId,
      organizationId: ctx.organizationId,
      allowedLocationIds: [input.locationId],
      deviceId: input.deviceId,
      permissionsHash: input.permissionsHash,
      issuedAt: now,
      expiresAt: input.expiresAt ?? new Date(Date.now() + 8 * 3600_000).toISOString(),
      policyVersion: input.policyVersion
    };
    const lease = {
      ...leasePayload,
      signature: sign(
        null,
        Buffer.from(canonical(leasePayload)),
        this.config.OFFLINE_LEASE_SIGNING_PRIVATE_KEY.replace(/\\n/g, '\n')
      ).toString('base64')
    };
    const unsigned = {
      schemaVersion: 1,
      packageId,
      organizationId: ctx.organizationId,
      locationId: input.locationId,
      ...(input.zoneIds ? { zoneIds: input.zoneIds } : {}),
      createdAt: now,
      baselineServerRevision,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      policyVersion: input.policyVersion,
      inventoryScopeHash: hash(expectedTags.map((tag) => tag.epc)),
      authorizationLease: lease,
      expectedTags,
      tagDirectory: expectedTags.map((tag) => ({
        epc: tag.epc,
        tagId: tag.tagId,
        productVariantId: tag.productVariantId,
        currentLocationId: tag.expectedLocationId,
        status: tag.status,
        sku: tag.sku,
        displayName: tag.displayName
      }))
    };
    const payloadHash = hash({
      expectedTags: unsigned.expectedTags,
      tagDirectory: unsigned.tagDirectory
    });
    const manifestHash = hash({ ...unsigned, expectedTags: undefined, tagDirectory: undefined });
    const pkg = {
      ...unsigned,
      payloadHash,
      manifestHash,
      signature: sign(
        null,
        Buffer.from(manifestHash),
        this.config.OFFLINE_PACKAGE_SIGNING_PRIVATE_KEY.replace(/\\n/g, '\n')
      ).toString('base64')
    };
    await this.database.pool.query(
      'INSERT INTO offline_inventory_packages (id, organization_id, location_id, baseline_server_revision, package, created_by, expires_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::timestamptz)',
      [
        packageId,
        ctx.organizationId,
        input.locationId,
        baselineServerRevision,
        JSON.stringify(pkg),
        ctx.userId,
        input.expiresAt ?? null
      ]
    );
    return pkg;
  }
  @Get('packages') async list(@Req() request: Request) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'sync.read');
    return (
      await this.database.pool.query<{ package: unknown }>(
        "SELECT package FROM offline_inventory_packages WHERE organization_id=$1 AND created_by=$2 AND package->'authorizationLease'->>'deviceId'=$3 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 100",
        [ctx.organizationId, ctx.userId, ctx.deviceId ?? '']
      )
    ).rows.map((row) => row.package);
  }
  @Post('packages/:id/revoke') async revoke(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'sync.write');
    await this.database.pool.query(
      'UPDATE offline_inventory_packages SET revoked_at=COALESCE(revoked_at,now()), revoked_by=$3 WHERE organization_id=$1 AND id=$2 AND (created_by=$3 OR $4)',
      [ctx.organizationId, parseWithSchema(uuidSchema, id), ctx.userId, ctx.isOwner ?? false]
    );
    return { revoked: true };
  }
  @Post('counts/upload') async upload(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'sync.write');
    const input = parseWithSchema(uploadSchema, body);
    const pkg = await this.database.pool.query<{
      baseline_server_revision: string;
      location_id: string;
    }>(
      "SELECT baseline_server_revision,location_id FROM offline_inventory_packages WHERE organization_id=$1 AND id=$2 AND created_by=$3 AND package->'authorizationLease'->>'deviceId'=$4 AND revoked_at IS NULL AND expires_at>now()",
      [ctx.organizationId, input.packageId, ctx.userId, ctx.deviceId ?? '']
    );
    if (
      !pkg.rows[0] ||
      Number(pkg.rows[0].baseline_server_revision) !== input.baselineServerRevision
    )
      throw new PermissionDeniedError('offline.package');
    requireScopedPermission(ctx, ['rfid_counts.sync'], pkg.rows[0].location_id);
    const existing = await this.database.pool.query<{
      reconciliation: unknown;
      package_id: string;
    }>(
      'SELECT reconciliation,package_id FROM standalone_count_evidence WHERE organization_id=$1 AND idempotency_key=$2',
      [ctx.organizationId, input.idempotencyKey]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].package_id !== input.packageId)
        throw new PermissionDeniedError('offline.idempotency');
      return existing.rows[0].reconciliation;
    }
    const changes = await this.database.pool.query<{
      epc: string;
      payload: Record<string, unknown>;
      revision: string;
    }>(
      "SELECT upper(payload->>'epc') AS epc, payload, revision FROM server_sync_events WHERE organization_id=$1 AND revision>$2 AND payload ? 'epc' AND (location_id IS NULL OR location_id=$3)",
      [ctx.organizationId, input.baselineServerRevision, pkg.rows[0].location_id]
    );
    const byEpc = new Map(changes.rows.filter((row) => row.epc).map((row) => [row.epc, row]));
    const concurrent = input.observations
      .filter((item) => byEpc.has(item.epc.toUpperCase()))
      .map((item) => ({
        epc: item.epc,
        reason: 'CONCURRENT_CHANGE_SINCE_PACKAGE',
        currentState: byEpc.get(item.epc.toUpperCase())?.payload
      }));
    const safeEpcs = input.observations
      .filter((item) => !byEpc.has(item.epc.toUpperCase()))
      .map((item) => item.epc);
    const result = {
      countSessionId: input.countSessionId,
      status:
        concurrent.length === 0
          ? 'RECONCILED'
          : safeEpcs.length === 0
            ? 'NEEDS_REVIEW'
            : 'PARTIALLY_RECONCILED',
      safeEpcs,
      concurrent,
      serverRevision: changes.rows.reduce(
        (max, row) => Math.max(max, Number(row.revision)),
        input.baselineServerRevision
      )
    };
    await this.database.pool.query(
      'INSERT INTO standalone_count_evidence (organization_id,count_session_id,package_id,idempotency_key,evidence,reconciliation) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)',
      [
        ctx.organizationId,
        input.countSessionId,
        input.packageId,
        input.idempotencyKey,
        JSON.stringify(input),
        JSON.stringify(result)
      ]
    );
    return result;
  }
}
