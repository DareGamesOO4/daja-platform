import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { createHash, randomUUID, sign } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import type { AppConfig } from '@daja/config';
import type { Database } from '@daja/database';
import { requirePermission, PermissionDeniedError, ValidationFailedError } from '@daja/security';
import { AuthRepository } from '@daja/database';
import { parseWithSchema, uuidSchema } from '@daja/validation';
import { requireScopedPermission } from './access-policy.js';
import { CONFIG, DATABASE } from './tokens.js';
import { resolveRequestContext } from './runtime/request-context.js';

const createSchema = z.object({
  locationId: z.string().uuid(),
  zoneIds: z.array(z.string().uuid()).max(200).optional(),
  expiresAt: z.string().datetime().optional(),
  deviceId: z.string().uuid(),
  userId: z.string().uuid(),
  permissionsHash: z.string().min(1).max(256),
  policyVersion: z.number().int().positive()
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
