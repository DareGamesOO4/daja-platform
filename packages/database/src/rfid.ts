/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import type pg from 'pg';
import {
  ResourceConflictError,
  ResourceNotFoundError,
  TenantAccessDeniedError,
  ValidationFailedError,
  VersionConflictError
} from '@daja/security';
import type { RequestContext } from '@daja/shared';
import { normalizeEpc } from '@daja/validation';

export class RfidRepository {
  constructor(private readonly client: Pick<pg.Pool | pg.PoolClient, 'query'>) {}

  async createTag(
    ctx: RequestContext,
    input: {
      epc: string;
      tid?: string | null | undefined;
      chipType?: string | null | undefined;
      protocol?: string | null | undefined;
      variantId?: string | null | undefined;
    }
  ) {
    const epc = normalizeEpc(input.epc);
    if (input.variantId) {
      await this.assertVariant(ctx.organizationId, input.variantId);
    }
    try {
      const result = await this.client.query(
        `INSERT INTO rfid_tags (organization_id, epc, tid, chip_type, protocol, status, variant_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, organization_id AS "organizationId", epc, tid, chip_type AS "chipType", protocol, status,
                   inventory_item_id AS "inventoryItemId", variant_id AS "variantId", version`,
        [
          ctx.organizationId,
          epc,
          input.tid ? normalizeEpc(input.tid) : null,
          input.chipType ?? null,
          input.protocol ?? null,
          input.variantId ? 'assigned' : 'unassigned',
          input.variantId ?? null
        ]
      );
      return result.rows[0];
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ResourceConflictError('Active EPC already exists');
      }
      throw error;
    }
  }

  async getTagById(ctx: Pick<RequestContext, 'organizationId'>, id: string) {
    const result = await this.client.query(
      `SELECT id, organization_id AS "organizationId", epc, tid, chip_type AS "chipType", protocol, status,
              inventory_item_id AS "inventoryItemId", variant_id AS "variantId", first_seen_at AS "firstSeenAt",
              last_seen_at AS "lastSeenAt", version
       FROM rfid_tags
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.organizationId, id]
    );
    if (result.rowCount !== 1) {
      throw new TenantAccessDeniedError();
    }
    return result.rows[0];
  }

  async getTagByEpc(ctx: Pick<RequestContext, 'organizationId'>, rawEpc: string) {
    const epc = normalizeEpc(rawEpc);
    const result = await this.client.query(
      `SELECT id, organization_id AS "organizationId", epc, tid, chip_type AS "chipType", protocol, status,
              inventory_item_id AS "inventoryItemId", variant_id AS "variantId", first_seen_at AS "firstSeenAt",
              last_seen_at AS "lastSeenAt", version
       FROM rfid_tags
       WHERE organization_id = $1 AND epc = $2 AND deleted_at IS NULL`,
      [ctx.organizationId, epc]
    );
    if (result.rowCount !== 1) {
      throw new ResourceNotFoundError('rfid tag');
    }
    return result.rows[0];
  }

  async assignTag(
    ctx: RequestContext,
    input: {
      tagId: string;
      inventoryItemId: string;
      expectedVersion?: number | undefined;
      reason: string;
    }
  ) {
    const tag = await this.lockTag(ctx.organizationId, input.tagId);
    const item = await this.lockInventoryItem(ctx.organizationId, input.inventoryItemId);
    if (input.expectedVersion !== undefined && Number(tag.version) !== input.expectedVersion) {
      throw new VersionConflictError();
    }
    if (tag.inventory_item_id && tag.inventory_item_id !== input.inventoryItemId) {
      throw new ResourceConflictError('RFID tag is already assigned to a different inventory item');
    }
    if (tag.variant_id && tag.variant_id !== item.variant_id) {
      throw new ResourceConflictError('RFID tag variant contradicts inventory item variant');
    }
    const result = await this.client.query(
      `UPDATE rfid_tags
       SET inventory_item_id = $3, variant_id = NULL, status = $4, version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2
       RETURNING id, epc, status, inventory_item_id AS "inventoryItemId", variant_id AS "variantId", version`,
      [ctx.organizationId, input.tagId, input.inventoryItemId, item.status]
    );
    await this.client.query(
      `INSERT INTO rfid_tag_events (organization_id, tag_id, inventory_item_id, event_type, metadata)
       VALUES ($1, $2, $3, 'assigned', $4::jsonb)`,
      [
        ctx.organizationId,
        input.tagId,
        input.inventoryItemId,
        JSON.stringify({ reason: input.reason })
      ]
    );
    return result.rows[0];
  }

  async unassignTag(
    ctx: RequestContext,
    input: { tagId: string; expectedVersion?: number | undefined; reason: string }
  ) {
    const tag = await this.lockTag(ctx.organizationId, input.tagId);
    if (input.expectedVersion !== undefined && Number(tag.version) !== input.expectedVersion) {
      throw new VersionConflictError();
    }
    if (!tag.inventory_item_id && !tag.variant_id) {
      throw new ResourceConflictError('RFID tag is already unassigned');
    }
    const result = await this.client.query(
      `UPDATE rfid_tags
       SET inventory_item_id = NULL, variant_id = NULL, status = 'unassigned', version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2
       RETURNING id, epc, status, inventory_item_id AS "inventoryItemId", variant_id AS "variantId", version`,
      [ctx.organizationId, input.tagId]
    );
    await this.client.query(
      `INSERT INTO rfid_tag_events (organization_id, tag_id, inventory_item_id, event_type, metadata)
       VALUES ($1, $2, $3, 'unassigned', $4::jsonb)`,
      [
        ctx.organizationId,
        input.tagId,
        tag.inventory_item_id,
        JSON.stringify({ reason: input.reason })
      ]
    );
    return result.rows[0];
  }

  async updateStatus(
    ctx: RequestContext,
    input: {
      tagId: string;
      status: string;
      expectedVersion?: number | undefined;
      reason?: string | undefined;
    }
  ) {
    const allowed = [
      'unassigned',
      'assigned',
      'in_stock',
      'reserved',
      'sold',
      'returned',
      'transferred',
      'lost',
      'damaged',
      'retired'
    ];
    if (!allowed.includes(input.status)) {
      throw new ValidationFailedError('Invalid RFID tag status');
    }
    const tag = await this.lockTag(ctx.organizationId, input.tagId);
    if (input.expectedVersion !== undefined && Number(tag.version) !== input.expectedVersion) {
      throw new VersionConflictError();
    }
    const result = await this.client.query(
      `UPDATE rfid_tags
       SET status = $3, version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2
       RETURNING id, epc, status, inventory_item_id AS "inventoryItemId", variant_id AS "variantId", version`,
      [ctx.organizationId, input.tagId, input.status]
    );
    await this.client.query(
      `INSERT INTO rfid_tag_events (organization_id, tag_id, inventory_item_id, event_type, metadata)
       VALUES ($1, $2, $3, 'status_changed', $4::jsonb)`,
      [
        ctx.organizationId,
        input.tagId,
        tag.inventory_item_id,
        JSON.stringify({ from: tag.status, to: input.status, reason: input.reason ?? null })
      ]
    );
    return result.rows[0];
  }

  async listEvents(ctx: Pick<RequestContext, 'organizationId'>, tagId: string) {
    await this.getTagById(ctx, tagId);
    const result = await this.client.query(
      `SELECT id, tag_id AS "tagId", inventory_item_id AS "inventoryItemId", reader_id AS "readerId",
              antenna_id AS "antennaId", location_id AS "locationId", event_type AS "eventType",
              rssi, metadata, occurred_at AS "occurredAt"
       FROM rfid_tag_events
       WHERE organization_id = $1 AND tag_id = $2
       ORDER BY occurred_at DESC
       LIMIT 200`,
      [ctx.organizationId, tagId]
    );
    return result.rows;
  }

  async resolvePublic(ctx: Pick<RequestContext, 'organizationId'>, rawEpc: string) {
    const epc = normalizeEpc(rawEpc);
    const result = await this.client.query(
      `SELECT p.id AS "productId", v.id AS "variantId", p.slug
       FROM rfid_tags t
       LEFT JOIN inventory_items ii ON ii.id = t.inventory_item_id AND ii.organization_id = t.organization_id AND ii.deleted_at IS NULL
       JOIN product_variants v ON v.id = COALESCE(ii.variant_id, t.variant_id)
        AND v.organization_id = t.organization_id AND v.deleted_at IS NULL AND v.active AND v.published
       JOIN products p ON p.id = v.product_id
        AND p.organization_id = t.organization_id AND p.deleted_at IS NULL AND p.active AND p.published
       WHERE t.organization_id = $1 AND t.epc = $2 AND t.deleted_at IS NULL
         AND t.status IN ('assigned', 'in_stock', 'reserved', 'returned')
       LIMIT 1`,
      [ctx.organizationId, epc]
    );
    const row = result.rows[0];
    return row ? { found: true, ...row } : { found: false };
  }

  private async lockTag(organizationId: string, tagId: string) {
    const result = await this.client.query(
      `SELECT * FROM rfid_tags WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [organizationId, tagId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new TenantAccessDeniedError();
    }
    return row;
  }

  private async lockInventoryItem(organizationId: string, itemId: string) {
    const result = await this.client.query(
      `SELECT * FROM inventory_items WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [organizationId, itemId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new TenantAccessDeniedError();
    }
    return row;
  }

  private async assertVariant(organizationId: string, variantId: string): Promise<void> {
    const result = await this.client.query(
      `SELECT 1 FROM product_variants WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [organizationId, variantId]
    );
    if (result.rowCount !== 1) {
      throw new ValidationFailedError('Variant does not belong to organization');
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
