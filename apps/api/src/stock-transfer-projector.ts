import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { ValidationFailedError } from '@daja/security';
import type { RequestContext } from '@daja/shared';
import type { SyncPushEvent } from '@daja/database';

const uuid = z.string().uuid();
const stockLine = z.object({ productVariantId: uuid, quantity: z.number().int().positive().max(1000000) });
const createSchema = z.object({
  sourceLocationId: uuid, destinationLocationId: uuid, responsibleSenderId: uuid.optional(),
  productVariantIds: z.array(uuid), stockItems: z.array(stockLine).optional(),
  notes: z.string().max(1000).optional()
});
const actionSchema = z.object({
  transferId: uuid, fromStatus: z.string(), toStatus: z.enum(['preparing', 'in_transit', 'awaiting_confirmation', 'completed', 'cancelled']),
  baseVersion: z.number().int().positive(), scannedEpcs: z.array(z.string().regex(/^[A-F0-9]{8,64}$/)),
  receivedStockItems: z.array(stockLine).optional()
});

interface TransferLine {
  id: string;
  productVariantId: string;
  tagId: string | null;
  epc: string | null;
  expectedQuantity: number;
  sentQuantity: number;
  receivedQuantity: number;
}

interface TransferDocument {
  id: string;
  documentNumber: string;
  sourceLocationId: string;
  destinationLocationId: string;
  status: string;
  version: number;
  createdByUserId: string;
  responsibleSenderId: string | null;
  responsibleReceiverId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  dispatchedAt: string | null;
  receivedAt: string | null;
  items: TransferLine[];
}

interface TagPlacement {
  id: string;
  epc: string;
  status: string;
  variantId: string;
  locationId: string | null;
  inventoryItemId: string | null;
}

const transferable = new Set(['assigned', 'in_stock', 'returned', 'transferred']);
const invalid = (message: string): never => { throw new ValidationFailedError(message); };

export async function projectStockTransfer(
  client: Pick<pg.PoolClient, 'query'>,
  ctx: RequestContext,
  event: SyncPushEvent,
  kind: 'transfer.create' | 'transfer.action',
  input: Record<string, unknown>,
  entityIds: Record<string, unknown> | undefined
) {
  const org = ctx.organizationId;
  const id = event.aggregateId;
  const now = new Date().toISOString();
  const tags = async (variantIds: string[], lock = false) => (await client.query<TagPlacement>(
    `SELECT t.id, t.epc, t.status, COALESCE(t.variant_id, i.variant_id) AS "variantId",
            CASE WHEN placement.id IS NOT NULL THEN placement.location_id ELSE i.current_location_id END AS "locationId",
            t.inventory_item_id AS "inventoryItemId"
     FROM rfid_tags t LEFT JOIN inventory_items i ON i.id = t.inventory_item_id AND i.organization_id = t.organization_id
     LEFT JOIN LATERAL (
       SELECT e.id, e.location_id FROM rfid_tag_events e
       WHERE e.organization_id = t.organization_id AND e.tag_id = t.id AND e.event_type IN ('assigned', 'moved', 'returned')
       ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1
     ) placement ON true
     WHERE t.organization_id = $1 AND t.deleted_at IS NULL AND COALESCE(t.variant_id, i.variant_id) = ANY($2::uuid[])
     ORDER BY t.id ${lock ? 'FOR UPDATE OF t' : ''}`, [org, variantIds]
  )).rows;
  let document: TransferDocument;
  const balances: { locationId: string; variantId: string; quantity: number; binId: string | null }[] = [];
  const movedTags: { id: string; variantId: string; epc: string; locationId: string | null; status: string; version: number }[] = [];
  if (kind === 'transfer.create') {
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) return invalid('Podaci nacrta transfera nisu ispravni.');
    const request = parsed.data;
    const stock = request.stockItems ?? [];
    const variants = [...request.productVariantIds, ...stock.map((item) => item.productVariantId)];
    if (!variants.length || new Set(variants).size !== variants.length || request.sourceLocationId === request.destinationLocationId) {
      return invalid('Izaberite dve različite lokacije i jedinstvene artikle.');
    }
    const active = await client.query(
      `SELECT id FROM product_variants WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL AND active`,
      [org, variants]
    );
    if (active.rowCount !== variants.length) return invalid('Transfer sadrži nedostupan artikal.');
    const tagRows = (await tags(request.productVariantIds)).filter(
      (tag) => tag.locationId === request.sourceLocationId && transferable.has(tag.status)
    );
    const transmitted = z.array(z.object({
      id: uuid, productVariantId: uuid, tagId: uuid.nullable(), expectedQuantity: z.number().int().positive()
    })).safeParse(entityIds?.transferItems);
    if (entityIds?.transferItems !== undefined && !transmitted.success) return invalid('Spisak transfera nije ispravan.');
    const expectedTags = transmitted.success
      ? transmitted.data.filter((item) => item.tagId !== null).map((item) => {
          const tag = tagRows.find((candidate) => candidate.id === item.tagId && candidate.variantId === item.productVariantId);
          if (!tag || item.expectedQuantity !== 1) return invalid('RFID oznaka više nije na izvornoj lokaciji.');
          return { tag, id: item.id };
        })
      : tagRows.map((tag) => ({ tag, id: randomUUID() }));
    if (new Set(expectedTags.map(({ tag }) => tag.id)).size !== expectedTags.length ||
      request.productVariantIds.some((variantId) => !expectedTags.some(({ tag }) => tag.variantId === variantId))) {
      return invalid('Izabrani RFID artikli nemaju važeći spisak oznaka.');
    }
    const items: TransferLine[] = [
      ...expectedTags.map(({ id: lineId, tag }) => ({
        id: lineId, productVariantId: tag.variantId, tagId: tag.id, epc: tag.epc,
        expectedQuantity: 1, sentQuantity: 0, receivedQuantity: 0
      })),
      ...stock.map((line) => ({
        id: transmitted.success
          ? transmitted.data.find((item) => item.tagId === null && item.productVariantId === line.productVariantId)?.id ?? randomUUID()
          : randomUUID(),
        productVariantId: line.productVariantId, tagId: null, epc: null,
        expectedQuantity: line.quantity, sentQuantity: 0, receivedQuantity: 0
      }))
    ];
    if (new Set(items.map((item) => item.id)).size !== items.length) return invalid('Stavke transfera moraju biti jedinstvene.');
    document = {
      id, documentNumber: typeof entityIds?.documentNumber === 'string' && /^TR-[A-Za-z0-9-]{1,50}$/.test(entityIds.documentNumber)
        ? entityIds.documentNumber : `TR-${id}`,
      sourceLocationId: request.sourceLocationId, destinationLocationId: request.destinationLocationId,
      status: 'draft', version: 1, createdByUserId: ctx.userId!,
      responsibleSenderId: request.responsibleSenderId ?? null, responsibleReceiverId: null,
      notes: request.notes ?? null, createdAt: now, updatedAt: now, dispatchedAt: null, receivedAt: null, items
    };
  } else {
    const parsed = actionSchema.safeParse(input);
    if (!parsed.success || parsed.data.transferId !== id) return invalid('Komanda transfera nije ispravna.');
    const action = parsed.data;
    const row = (await client.query<{ document: TransferDocument }>(
      'SELECT document FROM stock_transfers WHERE organization_id = $1 AND id = $2 FOR UPDATE', [org, id]
    )).rows[0];
    if (!row) return invalid('Transfer nije pronađen u zajedničkoj bazi.');
    document = row.document;
    const sent = document.items.reduce((sum, item) => sum + item.sentQuantity, 0);
    const dispatch = action.toStatus === 'in_transit';
    const receive = action.toStatus === 'awaiting_confirmation';
    const validFrom: Record<typeof action.toStatus, string[]> = {
      preparing: ['draft', 'discrepancy'], in_transit: ['preparing'],
      awaiting_confirmation: ['in_transit', 'discrepancy'],
      completed: ['awaiting_confirmation'], cancelled: ['draft', 'preparing', 'discrepancy']
    };
    if (action.baseVersion !== document.version || action.fromStatus !== document.status ||
      !validFrom[action.toStatus].includes(document.status) ||
      (sent > 0 && ['preparing', 'in_transit', 'cancelled'].includes(action.toStatus))) {
      return invalid('Status transfera je promenjen. Osvežite podatke.');
    }
    const scans = new Set(action.scannedEpcs);
    const quantities = new Map((action.receivedStockItems ?? []).map((item) => [item.productVariantId, item.quantity]));
    if (((dispatch || receive) && [...scans].some((epc) => !document.items.some((item) => item.epc === epc))) ||
      quantities.size !== (action.receivedStockItems?.length ?? 0) ||
      [...quantities].some(([variantId]) => !receive || !document.items.some((item) => !item.tagId && item.productVariantId === variantId))) {
      return invalid('Artikal ili RFID oznaka nije na ovom transferu.');
    }
    if (dispatch && document.items.some((item) => item.epc && !scans.has(item.epc))) {
      return invalid('Pre otpreme očitajte sve RFID oznake sa spiska.');
    }
    const byVariant = new Map<string, number>();
    const location = dispatch ? document.sourceLocationId : document.destinationLocationId;
    const placements = dispatch || receive
      ? await tags([...new Set(document.items.map((item) => item.productVariantId))], true) : [];
    for (const item of document.items) {
      const received = receive ? (item.epc
        ? Number(scans.has(item.epc) && item.receivedQuantity === 0)
        : quantities.get(item.productVariantId) ?? 0) : 0;
      if (received > item.sentQuantity - item.receivedQuantity) return invalid('Primljena količina premašuje preostalu količinu.');
      if (dispatch || received > 0) {
        const delta = dispatch ? -item.expectedQuantity : received;
        byVariant.set(item.productVariantId, (byVariant.get(item.productVariantId) ?? 0) + delta);
        if (item.tagId) {
          const tag = placements.find((entry) => entry.id === item.tagId);
          if (!tag || (dispatch
            ? tag.locationId !== location || !transferable.has(tag.status)
            : tag.locationId !== null || tag.status !== 'transferred')) return invalid('RFID oznaka više nije raspoloživa.');
          const status = dispatch ? 'transferred' : 'in_stock';
          const target = dispatch ? null : location;
          const result = await client.query<{ version: string }>(
            `UPDATE rfid_tags SET status = $3, version = version + 1, updated_at = now()
             WHERE organization_id = $1 AND id = $2 RETURNING version::text`, [org, tag.id, status]
          );
          await client.query(
            `INSERT INTO rfid_tag_events (organization_id, tag_id, location_id, event_type, metadata, occurred_at)
             VALUES ($1, $2, $3, 'moved', $4::jsonb, clock_timestamp())`, [org, tag.id, target, JSON.stringify({ transferId: id })]
          );
          if (tag.inventoryItemId) await client.query(
            `UPDATE inventory_items SET status = $3, current_location_id = $4, current_bin_id = NULL,
             current_zone_id = NULL, version = version + 1, updated_at = now() WHERE organization_id = $1 AND id = $2`,
            [org, tag.inventoryItemId, status, target]
          );
          movedTags.push({ id: tag.id, variantId: item.productVariantId, epc: tag.epc, locationId: target, status, version: Number(result.rows[0]?.version ?? 1) });
        }
      }
      if (dispatch) item.sentQuantity = item.expectedQuantity;
      item.receivedQuantity += received;
    }
    for (const [variantId, delta] of [...byVariant].sort(([a], [b]) => a.localeCompare(b))) {
      const previous = (await client.query<{ quantity: number }>(
        'SELECT quantity FROM inventory_balances WHERE organization_id = $1 AND location_id = $2 AND variant_id = $3 FOR UPDATE',
        [org, location, variantId]
      )).rows[0]?.quantity ?? 0;
      const retainedTags = dispatch ? placements.filter((tag) => tag.variantId === variantId &&
        tag.locationId === location && transferable.has(tag.status) && !movedTags.some((moved) => moved.id === tag.id)).length : 0;
      if (previous + delta < retainedTags) return invalid('Na izvornoj lokaciji nema dovoljno raspoložive zalihe.');
      const balance = (await client.query<{ quantity: number; binId: string | null }>(
        `INSERT INTO inventory_balances (organization_id, location_id, variant_id, quantity) VALUES ($1, $2, $3, $4)
         ON CONFLICT (organization_id, location_id, variant_id) DO UPDATE
         SET quantity = inventory_balances.quantity + $5, version = inventory_balances.version + 1, updated_at = now()
         RETURNING quantity, bin_id AS "binId"`, [org, location, variantId, previous + delta, delta]
      )).rows[0]!;
      balances.push({ locationId: location, variantId, ...balance });
      await client.query(
        `INSERT INTO inventory_events (organization_id, variant_id, event_type, quantity_delta, from_location_id,
         to_location_id, source_type, source_id, actor_user_id) VALUES ($1, $2, 'moved', $3, $4, $5, 'stock_transfer', $6, $7)`,
        [org, variantId, delta, dispatch ? location : null, dispatch ? null : location, id, ctx.userId]
      );
    }
    const complete = document.items.every((item) => item.sentQuantity > 0 && item.receivedQuantity === item.sentQuantity);
    if (action.toStatus === 'completed' && !complete) return invalid('Prvo evidentirajte sve preostale stavke.');
    document.status = receive && !complete ? 'discrepancy' : action.toStatus;
    document.updatedAt = now;
    document.version += 1;
    if (dispatch) {
      document.dispatchedAt = now;
      document.responsibleSenderId ??= ctx.userId!;
    }
    if (receive) {
      document.responsibleReceiverId = ctx.userId!;
      if (complete) document.receivedAt = now;
    }
  }
  const locations = (await client.query(
    'SELECT id, code, name, type, active, version::int FROM locations WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL',
    [org, [document.sourceLocationId, document.destinationLocationId]]
  )).rows;
  if (locations.length !== 2 || (kind === 'transfer.create' && locations.some((location) => !location.active))) {
    return invalid('Izaberite dve aktivne lokacije.');
  }
  if (kind === 'transfer.create') {
    await client.query(
      'INSERT INTO stock_transfers (id, organization_id, source_location_id, destination_location_id, version, document) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
      [id, org, document.sourceLocationId, document.destinationLocationId, document.version, JSON.stringify(document)]
    );
  } else {
    await client.query(
      'UPDATE stock_transfers SET version = $3, document = $4::jsonb WHERE organization_id = $1 AND id = $2',
      [org, id, document.version, JSON.stringify(document)]
    );
  }
  return { kind: 'stock.transfer', transfer: document, locations, balances, tags: movedTags };
}
