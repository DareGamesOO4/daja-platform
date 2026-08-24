/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import type pg from 'pg';
import {
  ResourceConflictError,
  TenantAccessDeniedError,
  ValidationFailedError
} from '@daja/security';
import type { RequestContext } from '@daja/shared';

export class InventoryRepository {
  constructor(private readonly client: Pick<pg.Pool | pg.PoolClient, 'query'>) {}

  async createItem(
    ctx: RequestContext,
    input: {
      variantId: string;
      serialNumber?: string | null | undefined;
      locationId?: string | null | undefined;
      zoneId?: string | null | undefined;
      binId?: string | null | undefined;
      status?: string | undefined;
    }
  ) {
    await this.assertVariant(ctx.organizationId, input.variantId);
    if (input.locationId) {
      await this.assertLocation(ctx.organizationId, input.locationId);
      await this.assertStoragePlacement(ctx.organizationId, {
        locationId: input.locationId,
        zoneId: input.zoneId,
        binId: input.binId
      });
    } else if (input.zoneId || input.binId) {
      throw new ValidationFailedError('Warehouse zone and shelf require a location');
    }
    const status = input.status ?? 'in_stock';
    const result = await this.client.query(
      `INSERT INTO inventory_items (
         organization_id, variant_id, serial_number, status,
         current_location_id, current_zone_id, current_bin_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, variant_id AS "variantId", serial_number AS "serialNumber", status,
                 current_location_id AS "currentLocationId", current_zone_id AS "currentZoneId",
                 current_bin_id AS "currentBinId", version`,
      [
        ctx.organizationId,
        input.variantId,
        input.serialNumber ?? null,
        status,
        input.locationId ?? null,
        input.zoneId ?? null,
        input.binId ?? null
      ]
    );
    if (input.locationId && status === 'in_stock') {
      await this.adjust(ctx, {
        variantId: input.variantId,
        inventoryItemId: result.rows[0].id,
        locationId: input.locationId,
        zoneId: input.zoneId,
        binId: input.binId,
        quantityDelta: 1,
        sourceType: 'inventory_item_create',
        sourceId: result.rows[0].id,
        metadata: {
          serialNumber: input.serialNumber ?? null,
          ...(input.zoneId ? { zoneId: input.zoneId } : {}),
          ...(input.binId ? { binId: input.binId } : {})
        }
      });
    }
    return result.rows[0];
  }

  async adjust(
    ctx: RequestContext,
    input: {
      variantId: string;
      inventoryItemId?: string | null | undefined;
      locationId: string;
      zoneId?: string | null | undefined;
      binId?: string | null | undefined;
      quantityDelta: number;
      sourceType: string;
      sourceId?: string | null | undefined;
      metadata?: Record<string, unknown> | undefined;
    }
  ) {
    await this.assertVariant(ctx.organizationId, input.variantId);
    await this.assertLocation(ctx.organizationId, input.locationId);
    const hasPlacementChange = input.zoneId !== undefined || input.binId !== undefined;
    if (
      !Number.isInteger(input.quantityDelta) ||
      (input.quantityDelta === 0 && !hasPlacementChange)
    ) {
      throw new ValidationFailedError(
        'Inventory adjustment must change quantity or warehouse placement'
      );
    }
    const existing = await this.client.query<{
      quantity: number;
      zoneId: string | null;
      binId: string | null;
    }>(
      `SELECT quantity, zone_id AS "zoneId", bin_id AS "binId" FROM inventory_balances
       WHERE organization_id = $1 AND location_id = $2 AND variant_id = $3
       FOR UPDATE`,
      [ctx.organizationId, input.locationId, input.variantId]
    );
    const currentBalance = existing.rows[0];
    const current = currentBalance?.quantity ?? 0;
    const zoneId =
      input.zoneId !== undefined ? input.zoneId : (currentBalance?.zoneId ?? null);
    // Selecting another zone without choosing a shelf must not retain a shelf
    // that belongs to the previous zone.
    const binId =
      input.binId !== undefined
        ? input.binId
        : input.zoneId !== undefined && input.zoneId !== currentBalance?.zoneId
          ? null
          : (currentBalance?.binId ?? null);
    await this.assertStoragePlacement(ctx.organizationId, {
      locationId: input.locationId,
      zoneId,
      binId
    });
    const next = current + input.quantityDelta;
    if (next < 0) {
      throw new ResourceConflictError('Inventory balance cannot become negative', {
        current,
        attemptedDelta: input.quantityDelta
      });
    }
    await this.client.query(
      `INSERT INTO inventory_events (organization_id, variant_id, inventory_item_id, event_type, quantity_delta,
                                     to_location_id, source_type, source_id, actor_user_id, metadata)
       VALUES ($1, $2, $3, 'adjusted', $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        ctx.organizationId,
        input.variantId,
        input.inventoryItemId ?? null,
        input.quantityDelta,
        input.locationId,
        input.sourceType,
        input.sourceId ?? null,
        ctx.userId,
        JSON.stringify({
          ...(input.metadata ?? {}),
          ...(zoneId ? { zoneId } : {}),
          ...(binId ? { binId } : {})
        })
      ]
    );
    await this.client.query(
      `INSERT INTO inventory_balances (organization_id, location_id, variant_id, zone_id, bin_id, quantity)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (organization_id, location_id, variant_id) DO UPDATE
       SET zone_id = EXCLUDED.zone_id, bin_id = EXCLUDED.bin_id, quantity = EXCLUDED.quantity,
           version = inventory_balances.version + 1, updated_at = now()`,
      [ctx.organizationId, input.locationId, input.variantId, zoneId, binId, next]
    );
    return { variantId: input.variantId, locationId: input.locationId, zoneId, binId, quantity: next };
  }

  async moveItem(
    ctx: RequestContext,
    input: { inventoryItemId: string; toLocationId: string; reason: string }
  ) {
    await this.assertLocation(ctx.organizationId, input.toLocationId);
    const item = await this.client.query(
      `SELECT * FROM inventory_items WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [ctx.organizationId, input.inventoryItemId]
    );
    const row = item.rows[0];
    if (!row) {
      throw new TenantAccessDeniedError();
    }
    const fromLocationId = row.current_location_id as string | null;
    if (fromLocationId === input.toLocationId) {
      return { inventoryItemId: input.inventoryItemId, locationId: input.toLocationId };
    }
    if (fromLocationId) {
      await this.adjust(ctx, {
        variantId: row.variant_id,
        inventoryItemId: input.inventoryItemId,
        locationId: fromLocationId,
        quantityDelta: -1,
        sourceType: 'inventory_item_move',
        sourceId: input.inventoryItemId,
        metadata: { reason: input.reason, direction: 'from' }
      });
    }
    await this.adjust(ctx, {
      variantId: row.variant_id,
      inventoryItemId: input.inventoryItemId,
      locationId: input.toLocationId,
      quantityDelta: 1,
      sourceType: 'inventory_item_move',
      sourceId: input.inventoryItemId,
      metadata: { reason: input.reason, direction: 'to' }
    });
    await this.client.query(
      `UPDATE inventory_items
       SET current_location_id = $3, status = 'transferred', version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2`,
      [ctx.organizationId, input.inventoryItemId, input.toLocationId]
    );
    return { inventoryItemId: input.inventoryItemId, locationId: input.toLocationId };
  }

  async balances(ctx: Pick<RequestContext, 'organizationId'>, variantId: string) {
    const result = await this.client.query(
      `SELECT location_id AS "locationId", variant_id AS "variantId", zone_id AS "zoneId",
              bin_id AS "binId", quantity, version, updated_at AS "updatedAt"
       FROM inventory_balances
       WHERE organization_id = $1 AND variant_id = $2
       ORDER BY updated_at DESC`,
      [ctx.organizationId, variantId]
    );
    return result.rows;
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

  private async assertLocation(organizationId: string, locationId: string): Promise<void> {
    const result = await this.client.query(
      `SELECT 1 FROM locations WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [organizationId, locationId]
    );
    if (result.rowCount !== 1) {
      throw new ValidationFailedError('Location does not belong to organization');
    }
  }

  private async assertStoragePlacement(
    organizationId: string,
    input: {
      locationId: string;
      zoneId?: string | null | undefined;
      binId?: string | null | undefined;
    }
  ): Promise<void> {
    if (!input.zoneId && !input.binId) return;
    if (input.binId && !input.zoneId) {
      throw new ValidationFailedError('Warehouse shelf requires a zone');
    }
    const placement = await this.client.query<{ zoneId: string; binId: string | null }>(
      `SELECT zone.id AS "zoneId", bin.id AS "binId"
       FROM warehouse_zones zone
       JOIN warehouses warehouse
         ON warehouse.organization_id = zone.organization_id AND warehouse.id = zone.warehouse_id
       LEFT JOIN warehouse_bins bin
         ON bin.organization_id = zone.organization_id AND bin.id = $4 AND bin.zone_id = zone.id
         AND bin.deleted_at IS NULL AND bin.active
       WHERE zone.organization_id = $1 AND zone.id = $2 AND warehouse.location_id = $3
         AND zone.deleted_at IS NULL AND zone.active AND warehouse.deleted_at IS NULL AND warehouse.active`,
      [organizationId, input.zoneId ?? null, input.locationId, input.binId ?? null]
    );
    const row = placement.rows[0];
    if (!row || (input.binId !== undefined && input.binId !== null && row.binId !== input.binId)) {
      throw new ValidationFailedError(
        'Warehouse zone or shelf does not belong to selected location'
      );
    }
  }
}
