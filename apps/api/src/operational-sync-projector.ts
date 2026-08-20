import { createHash } from 'node:crypto';
import { SyncRepository, type SyncPushEvent } from '@daja/database';
import { ResourceConflictError, ValidationFailedError } from '@daja/security';
import type { RequestContext } from '@daja/shared';
import type pg from 'pg';

type ItemCommand = {
  kind: 'item.create' | 'item.update' | 'item.archive' | 'item.delete';
  payload: Record<string, unknown>;
};

type TagCommand = { kind: 'tag.assign'; payload: Record<string, unknown> };

type DesktopCommand = ItemCommand | TagCommand;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function integer(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function boolean(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof input[key] === 'boolean' ? (input[key] as boolean) : fallback;
}

function slug(value: string, suffix: string): string {
  const base = value
    .toLocaleLowerCase('sr-Latn-RS')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);
  return `${base || 'artikal'}-${suffix.slice(0, 8)}`;
}

/**
 * Converts RFIDDaja's local business commands into writes against the actual
 * Platform tables. The resulting snapshot is persisted in server_sync_events,
 * so another desktop can apply the same canonical record without replaying a
 * local command.
 */
export class OperationalSyncProjector {
  constructor(private readonly client: Pick<pg.Pool | pg.PoolClient, 'query'>) {}

  async materialize(ctx: RequestContext, event: SyncPushEvent): Promise<SyncPushEvent> {
    const envelope = record(event.payload);
    const command = record(envelope?.command);
    const kind = command?.kind;
    const commandPayload = record(command?.payload);
    if (!envelope || !command || !commandPayload || typeof kind !== 'string') return event;

    const entityIds = record(envelope.entityIds);
    if (kind.startsWith('item.')) {
      const snapshot = await this.item(
        ctx,
        event,
        { kind: kind as ItemCommand['kind'], payload: commandPayload },
        entityIds
      );
      return { ...event, payload: { ...event.payload, operationalSnapshot: snapshot } };
    }
    if (kind === 'tag.assign') {
      const snapshot = await this.tag(ctx, event, { kind: 'tag.assign', payload: commandPayload });
      return { ...event, payload: { ...event.payload, operationalSnapshot: snapshot } };
    }

    // Existing generic events remain compatible. They deliberately stay event
    // log entries until their server domain model has a matching projector.
    return event;
  }

  private async item(
    ctx: RequestContext,
    event: SyncPushEvent,
    command: ItemCommand,
    entityIds: Record<string, unknown> | undefined
  ): Promise<Record<string, unknown>> {
    const input = command.payload;
    const sku = text(input, 'sku');
    const name = text(input, 'name');
    const priceRsd = integer(input, 'salePriceMinor');
    const currency = text(input, 'currency') ?? 'RSD';
    const variantId =
      command.kind === 'item.create' ? event.aggregateId : (text(input, 'id') ?? event.aggregateId);
    if (command.kind === 'item.create') {
      if (!sku || !name || priceRsd === undefined || priceRsd < 0) {
        throw new ValidationFailedError('Desktop item create command is incomplete');
      }
      const productId =
        text(input, 'productId') ??
        (entityIds === undefined ? undefined : text(entityIds, 'productId'));
      const categoryId = text(input, 'categoryId');
      const existing = await this.client.query<{ id: string; product_id: string }>(
        `SELECT id, product_id FROM product_variants
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [ctx.organizationId, variantId]
      );
      if (existing.rowCount === 1)
        return this.catalogSnapshot(ctx.organizationId, existing.rows[0]!.product_id, variantId);

      const category = categoryId
        ? await this.client.query<{ id: string }>(
            `SELECT id FROM categories WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
            [ctx.organizationId, categoryId]
          )
        : undefined;
      // RFID stores a storefront category as a child of its local brand.
      // Sync sends that parent name explicitly; older clients fall back to
      // categoryName so their existing events remain compatible.
      const localBrandName =
        entityIds === undefined
          ? undefined
          : (text(entityIds, 'brandName') ?? text(entityIds, 'categoryName'));
      const brand = localBrandName
        ? await this.client.query<{ id: string }>(
            `SELECT id FROM brands
             WHERE organization_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL AND active
             LIMIT 1`,
            [ctx.organizationId, localBrandName]
          )
        : undefined;
      const resolvedProductId = productId ?? event.aggregateId;
      await this.client.query(
        `INSERT INTO products (id, organization_id, name, slug, brand_id, primary_category_id, active, published, external_id)
         VALUES ($1, $2, $3, $4, $5, $6, true, true, $7)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now(), version = products.version + 1`,
        [
          resolvedProductId,
          ctx.organizationId,
          name,
          slug(name, variantId),
          brand?.rows[0]?.id ?? null,
          category?.rows[0]?.id ?? null,
          `rfiddaja:${variantId}`
        ]
      );
      await this.client.query(
        `INSERT INTO product_variants (id, organization_id, product_id, sku, barcode, name, current_price_amount, currency, attributes, active, published)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, true, true)`,
        [
          variantId,
          ctx.organizationId,
          resolvedProductId,
          sku,
          text(input, 'barcode') ?? null,
          name,
          priceRsd * 100,
          currency,
          JSON.stringify(record(input.attributes) ?? {})
        ]
      );
      await this.client.query(
        `INSERT INTO variant_prices (organization_id, variant_id, amount_minor, currency, price_type, created_by)
         VALUES ($1, $2, $3, $4, 'sell', $5)`,
        [ctx.organizationId, variantId, priceRsd * 100, currency, ctx.userId]
      );
      await this.setImage(ctx.organizationId, resolvedProductId, text(input, 'imageUri'));
      return this.catalogSnapshot(ctx.organizationId, resolvedProductId, variantId);
    }

    const current = await this.client.query<{ product_id: string; version: string }>(
      `SELECT product_id, version::text FROM product_variants
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [ctx.organizationId, variantId]
    );
    const row = current.rows[0];
    if (!row) throw new ValidationFailedError('Desktop item does not exist on Platform');
    const expected = integer(input, 'baseVersion') ?? event.baseVersion ?? undefined;
    if (expected !== undefined && Number(row.version) !== expected) {
      throw new ResourceConflictError('Base version does not match server version');
    }
    if (command.kind === 'item.delete') {
      await this.client.query(
        `UPDATE product_variants SET deleted_at = now(), active = false, published = false, version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2`,
        [ctx.organizationId, variantId]
      );
      // RFID desktop deletes a variant. When it was the product's last
      // variant, hide the now-empty parent product as well. Otherwise staff
      // catalog queries retain a ghost product although the public catalog
      // and RFID snapshot correctly have no item to show.
      await this.client.query(
        `UPDATE products p
         SET deleted_at = now(), active = false, published = false,
             version = version + 1, updated_at = now()
         WHERE p.organization_id = $1 AND p.id = $2 AND p.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM product_variants v
             WHERE v.organization_id = p.organization_id
               AND v.product_id = p.id AND v.deleted_at IS NULL
           )`,
        [ctx.organizationId, row.product_id]
      );
      return { kind: 'catalog.item', deleted: true, productId: row.product_id, variantId };
    }
    if (command.kind === 'item.archive') {
      await this.client.query(
        `UPDATE product_variants SET active = false, published = false, version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2`,
        [ctx.organizationId, variantId]
      );
      return this.catalogSnapshot(ctx.organizationId, row.product_id, variantId);
    }
    if (!sku || !name || priceRsd === undefined || priceRsd < 0) {
      throw new ValidationFailedError('Desktop item update command is incomplete');
    }
    const categoryId = text(input, 'categoryId');
    const validCategory = categoryId
      ? await this.client.query<{ id: string }>(
          `SELECT id FROM categories WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [ctx.organizationId, categoryId]
        )
      : undefined;
    const localBrandName =
      entityIds === undefined
        ? undefined
        : (text(entityIds, 'brandName') ?? text(entityIds, 'categoryName'));
    const brand = localBrandName
      ? await this.client.query<{ id: string }>(
          `SELECT id FROM brands
           WHERE organization_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL AND active
           LIMIT 1`,
          [ctx.organizationId, localBrandName]
        )
      : undefined;
    await this.client.query(
      `UPDATE products SET name = $3, brand_id = COALESCE($4, brand_id), primary_category_id = COALESCE($5, primary_category_id), version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2`,
      [
        ctx.organizationId,
        row.product_id,
        name,
        brand?.rows[0]?.id ?? null,
        validCategory?.rows[0]?.id ?? null
      ]
    );
    await this.client.query(
      `UPDATE product_variants SET sku = $3, barcode = $4, name = $5, current_price_amount = $6, currency = $7,
       attributes = $8::jsonb, version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2`,
      [
        ctx.organizationId,
        variantId,
        sku,
        text(input, 'barcode') ?? null,
        name,
        priceRsd * 100,
        currency,
        JSON.stringify(record(input.attributes) ?? {})
      ]
    );
    await this.client.query(
      `UPDATE variant_prices SET valid_until = now() WHERE organization_id = $1 AND variant_id = $2 AND price_type = 'sell' AND valid_until IS NULL`,
      [ctx.organizationId, variantId]
    );
    await this.client.query(
      `INSERT INTO variant_prices (organization_id, variant_id, amount_minor, currency, price_type, created_by)
       VALUES ($1, $2, $3, $4, 'sell', $5)`,
      [ctx.organizationId, variantId, priceRsd * 100, currency, ctx.userId]
    );
    await this.setImage(ctx.organizationId, row.product_id, text(input, 'imageUri'));
    return this.catalogSnapshot(ctx.organizationId, row.product_id, variantId);
  }

  private async tag(
    ctx: RequestContext,
    event: SyncPushEvent,
    command: TagCommand
  ): Promise<Record<string, unknown>> {
    const epc = text(command.payload, 'epc');
    const variantId = text(command.payload, 'productVariantId');
    if (!epc || !variantId) throw new ValidationFailedError('Desktop RFID command is incomplete');
    const result = await this.client.query(
      `INSERT INTO rfid_tags (id, organization_id, epc, tid, variant_id, status)
       VALUES ($1, $2, upper($3), $4, $5, 'assigned')
       ON CONFLICT (id) DO UPDATE SET epc = EXCLUDED.epc, tid = EXCLUDED.tid, variant_id = EXCLUDED.variant_id,
         status = 'assigned', version = rfid_tags.version + 1, updated_at = now()
       RETURNING id, epc, tid, variant_id AS "variantId", status, version`,
      [event.aggregateId, ctx.organizationId, epc, text(command.payload, 'tid') ?? null, variantId]
    );
    return { kind: 'rfid.tag', tag: result.rows[0] };
  }

  private async setImage(
    organizationId: string,
    productId: string,
    imageUri: string | undefined
  ): Promise<void> {
    if (!imageUri || !/^https?:\/\//i.test(imageUri)) return;
    const storageKey = createHash('sha256').update(imageUri).digest('hex');
    const media = await this.client.query<{ id: string }>(
      `INSERT INTO media_assets (organization_id, storage_provider, storage_bucket, storage_key, public_url, mime_type, status)
       VALUES ($1, 'external-url', 'external', $2, $3, 'image/*', 'ready')
       ON CONFLICT (organization_id, storage_bucket, storage_key) WHERE deleted_at IS NULL
       DO UPDATE SET public_url = EXCLUDED.public_url, status = 'ready', updated_at = now()
       RETURNING id`,
      [organizationId, storageKey, imageUri]
    );
    const mediaId = media.rows[0]?.id;
    if (!mediaId) return;
    await this.client.query(
      `UPDATE product_media SET is_primary = false WHERE organization_id = $1 AND product_id = $2`,
      [organizationId, productId]
    );
    await this.client.query(
      `INSERT INTO product_media (organization_id, product_id, media_asset_id, role, position, is_primary)
       SELECT $1, $2, $3, 'gallery', 0, true
       WHERE NOT EXISTS (SELECT 1 FROM product_media WHERE organization_id = $1 AND product_id = $2 AND media_asset_id = $3)`,
      [organizationId, productId, mediaId]
    );
  }

  async catalogSnapshot(
    organizationId: string,
    productId: string,
    variantId: string
  ): Promise<Record<string, unknown>> {
    const result = await this.client.query(
      `SELECT p.id AS "productId", p.name AS "productName", p.description, p.primary_category_id AS "categoryId",
              c.name AS "categoryName", b.name AS "brandName", p.version AS "productVersion",
              v.id AS "variantId", v.sku, v.barcode, v.name AS "variantName", v.current_price_amount AS "priceAmount",
              v.currency, v.attributes, v.active, v.published, v.version AS "variantVersion", media.public_url AS "imageUri"
       FROM products p JOIN product_variants v ON v.organization_id = p.organization_id AND v.product_id = p.id
       LEFT JOIN brands b ON b.id = p.brand_id AND b.organization_id = p.organization_id AND b.deleted_at IS NULL
       LEFT JOIN categories c ON c.id = p.primary_category_id AND c.organization_id = p.organization_id AND c.deleted_at IS NULL
       LEFT JOIN LATERAL (SELECT ma.public_url FROM product_media pm JOIN media_assets ma ON ma.id = pm.media_asset_id
                          WHERE pm.organization_id = p.organization_id AND pm.product_id = p.id AND ma.status = 'ready'
                          ORDER BY pm.is_primary DESC, pm.position LIMIT 1) media ON true
       WHERE p.organization_id = $1 AND p.id = $2 AND v.id = $3`,
      [organizationId, productId, variantId]
    );
    return { kind: 'catalog.item', record: result.rows[0] ?? { productId, variantId } };
  }

  async publishProductChange(
    ctx: RequestContext,
    productId: string,
    variantId: string,
    operation: 'create' | 'update' | 'delete' = 'update'
  ): Promise<void> {
    const snapshot =
      operation === 'delete'
        ? { kind: 'catalog.item', deleted: true, productId, variantId }
        : await this.catalogSnapshot(ctx.organizationId, productId, variantId);
    const record = (snapshot.record ?? {}) as Record<string, unknown>;
    // PostgreSQL bigint values are returned as strings by node-postgres by
    // default. Treating them as non-numeric made every update use version 1
    // and collide with the unique sync idempotency key after the first save.
    const version = Number(record.variantVersion) || 1;
    await new SyncRepository(this.client).appendServerEvent(ctx, {
      aggregateType: 'product_variant',
      aggregateId: variantId,
      operation,
      payload: { operationalSnapshot: snapshot },
      payloadVersion: 2,
      idempotencyKey: `catalog:${productId}:${variantId}:${operation}:${version}`
    });
  }
}
