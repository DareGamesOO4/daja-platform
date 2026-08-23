import { createHash } from 'node:crypto';
import { SyncRepository, type SyncPushEvent } from '@daja/database';
import { ValidationFailedError } from '@daja/security';
import type { RequestContext } from '@daja/shared';
import type pg from 'pg';

type ItemCommand = {
  kind: 'item.create' | 'item.update' | 'item.archive' | 'item.delete';
  payload: Record<string, unknown>;
};

type TagCommand = { kind: 'tag.assign'; payload: Record<string, unknown> };

type LocationCommand = { kind: 'location.upsert'; payload: Record<string, unknown> };

type SettingsCommand = { kind: 'settings.update'; payload: Record<string, unknown> };

type DesktopCommand = ItemCommand | TagCommand | LocationCommand | SettingsCommand;

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
    if (kind === 'location.upsert') {
      const snapshot = await this.location(ctx, event, {
        kind: 'location.upsert',
        payload: commandPayload
      });
      return { ...event, payload: { ...event.payload, operationalSnapshot: snapshot } };
    }
    if (kind === 'settings.update') {
      const snapshot = await this.settings(ctx, {
        kind: 'settings.update',
        payload: commandPayload
      });
      return { ...event, payload: { ...event.payload, operationalSnapshot: snapshot } };
    }

    // Existing generic events remain compatible. They deliberately stay event
    // log entries until their server domain model has a matching projector.
    return event;
  }

  /**
   * A location is the shared key between the RFID desktop inventory and the
   * web product modal. Persist the desktop UUID itself: inventing a second
   * Platform UUID makes later inventory and EPC events point at a location
   * that does not exist on the other side.
   */
  private async location(
    ctx: RequestContext,
    event: SyncPushEvent,
    command: LocationCommand
  ): Promise<Record<string, unknown>> {
    const input = command.payload;
    const id = text(input, 'id') ?? event.aggregateId;
    const code = text(input, 'code');
    const name = text(input, 'name');
    const type = text(input, 'type') ?? 'store';
    if (!code || !name || !['warehouse', 'store', 'office', 'virtual'].includes(type)) {
      throw new ValidationFailedError('Desktop location upsert command is incomplete');
    }

    const result = await this.client.query<{
      id: string;
      code: string;
      name: string;
      type: string;
      active: boolean;
      version: string;
    }>(
      `INSERT INTO locations (id, organization_id, code, name, type, timezone, active)
       VALUES ($1, $2, upper($3), $4, $5, 'Europe/Belgrade', $6)
       ON CONFLICT (id) DO UPDATE
       SET code = EXCLUDED.code,
           name = EXCLUDED.name,
           type = EXCLUDED.type,
           timezone = EXCLUDED.timezone,
           active = EXCLUDED.active,
           deleted_at = NULL,
           version = locations.version + 1,
           updated_at = now()
       RETURNING id, code, name, type, active, version::text AS version`,
      [id, ctx.organizationId, code, name, type, boolean(input, 'active', true)]
    );
    return { kind: 'location', location: result.rows[0] };
  }

  private async settings(
    ctx: RequestContext,
    command: SettingsCommand
  ): Promise<Record<string, unknown>> {
    const values = record(command.payload.values);
    if (!values || text(command.payload, 'scope') !== 'organization') {
      throw new ValidationFailedError('Desktop organization settings command is incomplete');
    }
    const result = await this.client.query<{
      id: string;
      name: string;
      legalName: string | null;
      taxNumber: string | null;
      version: string;
    }>(
      `UPDATE organizations
       SET name = COALESCE($2, name),
           legal_name = COALESCE($3, legal_name),
           tax_number = COALESCE($4, tax_number),
           version = version + 1,
           updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, name, legal_name AS "legalName", tax_number AS "taxNumber", version::text AS version`,
      [
        ctx.organizationId,
        text(values, 'company.name'),
        text(values, 'company.legalName'),
        text(values, 'company.taxNumber')
      ]
    );
    if (!result.rows[0])
      throw new ValidationFailedError('Desktop organization does not exist on Platform');
    return { kind: 'organization.settings', organization: result.rows[0] };
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
      const departmentName = text(input, 'department');
      const department = departmentName
        ? await this.client.query<{ id: string }>(
            `SELECT id FROM departments
             WHERE organization_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL AND active
             LIMIT 1`,
            [ctx.organizationId, departmentName]
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
        `INSERT INTO products (id, organization_id, name, slug, description, brand_id, primary_category_id, seo, features, model_3d_url, active, published, external_id, department_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug,
           description = EXCLUDED.description, seo = EXCLUDED.seo, features = EXCLUDED.features,
           model_3d_url = EXCLUDED.model_3d_url, department_id = EXCLUDED.department_id,
           active = EXCLUDED.active, published = EXCLUDED.published,
           updated_at = now(), version = products.version + 1`,
        [
          resolvedProductId,
          ctx.organizationId,
          name,
          text(input, 'slug') ?? slug(name, variantId),
          text(input, 'description') ?? null,
          brand?.rows[0]?.id ?? null,
          category?.rows[0]?.id ?? null,
          JSON.stringify(record(input.seo) ?? {}),
          JSON.stringify(Array.isArray(input.features) ? input.features : []),
          text(input, 'model3dUrl') ?? null,
          boolean(input, 'active', true),
          boolean(input, 'published', true),
          `rfiddaja:${variantId}`,
          department?.rows[0]?.id ?? null
        ]
      );
      await this.client.query(
        `INSERT INTO product_variants (id, organization_id, product_id, sku, barcode, name, gender, current_price_amount, currency, attributes, active, published)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)`,
        [
          variantId,
          ctx.organizationId,
          resolvedProductId,
          sku,
          text(input, 'barcode') ?? null,
          name,
          text(input, 'gender') ?? null,
          priceRsd * 100,
          currency,
          JSON.stringify(record(input.attributes) ?? {}),
          boolean(input, 'active', true),
          boolean(input, 'published', true)
        ]
      );
      await this.client.query(
        `INSERT INTO variant_prices (organization_id, variant_id, amount_minor, currency, price_type, created_by)
         VALUES ($1, $2, $3, $4, 'sell', $5)`,
        [ctx.organizationId, variantId, priceRsd * 100, currency, ctx.userId]
      );
      await this.addCatalogPrices(ctx, variantId, input, currency);
      await this.setImages(ctx.organizationId, resolvedProductId, input);
      return this.catalogSnapshot(ctx.organizationId, resolvedProductId, variantId);
    }

    const current = await this.client.query<{ product_id: string; version: string }>(
      `SELECT product_id, version::text FROM product_variants
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [ctx.organizationId, variantId]
    );
    const row = current.rows[0];
    if (!row) throw new ValidationFailedError('Desktop item does not exist on Platform');
    if (command.kind === 'item.delete') {
      await this.client.query(
        `UPDATE product_variants SET deleted_at = now(), active = false, published = false,
         version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND product_id = $2 AND deleted_at IS NULL`,
        [ctx.organizationId, row.product_id]
      );
      // The admin product modal deliberately has one internal sellable row,
      // not user-managed variants. Deleting the RFID article must therefore
      // remove the complete product, including any stale internal rows.
      await this.client.query(
        `UPDATE products p
         SET deleted_at = now(), active = false, published = false,
             version = version + 1, updated_at = now()
         WHERE p.organization_id = $1 AND p.id = $2 AND p.deleted_at IS NULL`,
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
    const departmentName = text(input, 'department');
    const department = departmentName
      ? await this.client.query<{ id: string }>(
          `SELECT id FROM departments
           WHERE organization_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL AND active
           LIMIT 1`,
          [ctx.organizationId, departmentName]
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
      `UPDATE products SET name = $3, slug = COALESCE(NULLIF($4, ''), slug), description = COALESCE($5, description),
       brand_id = COALESCE($6, brand_id), primary_category_id = COALESCE($7, primary_category_id),
       seo = COALESCE($8::jsonb, seo), features = COALESCE($9::jsonb, features), model_3d_url = COALESCE($10, model_3d_url),
       active = $11, published = $12, department_id = COALESCE($13, department_id),
       version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2`,
      [
        ctx.organizationId,
        row.product_id,
        name,
        text(input, 'slug') ?? null,
        text(input, 'description') ?? null,
        brand?.rows[0]?.id ?? null,
        validCategory?.rows[0]?.id ?? null,
        input.seo === undefined ? null : JSON.stringify(record(input.seo) ?? {}),
        input.features === undefined
          ? null
          : JSON.stringify(Array.isArray(input.features) ? input.features : []),
        text(input, 'model3dUrl') ?? null,
        boolean(input, 'active', true),
        boolean(input, 'published', true),
        department?.rows[0]?.id ?? null
      ]
    );
    await this.client.query(
      `UPDATE product_variants SET sku = $3, barcode = COALESCE(NULLIF($4, ''), barcode), name = $5, gender = COALESCE($6, gender), current_price_amount = $7, currency = $8,
       attributes = COALESCE($9::jsonb, attributes), active = $10, published = $11, version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2`,
      [
        ctx.organizationId,
        variantId,
        sku,
        text(input, 'barcode') ?? null,
        name,
        text(input, 'gender') ?? null,
        priceRsd * 100,
        currency,
        input.attributes === undefined ? null : JSON.stringify(record(input.attributes) ?? {}),
        boolean(input, 'active', true),
        boolean(input, 'published', true)
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
    await this.addCatalogPrices(ctx, variantId, input, currency);
    await this.setImages(ctx.organizationId, row.product_id, input);
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

  private async addCatalogPrices(
    ctx: RequestContext,
    variantId: string,
    input: Record<string, unknown>,
    currency: string
  ): Promise<void> {
    const saleAmount = integer(input, 'promotionalPriceMinor');
    const costAmount = integer(input, 'costPriceMinor');
    if (saleAmount !== undefined && saleAmount >= 0) {
      await this.client.query(
        `INSERT INTO variant_prices (organization_id, variant_id, amount_minor, currency, price_type, valid_from, valid_until, created_by)
         VALUES ($1, $2, $3, $4, 'sale', COALESCE($5::timestamptz, now()), $6::timestamptz, $7)`,
        [
          ctx.organizationId,
          variantId,
          saleAmount * 100,
          currency,
          text(input, 'promotionalValidFrom') ?? null,
          text(input, 'promotionalValidUntil') ?? null,
          ctx.userId
        ]
      );
    }
    if (costAmount !== undefined && costAmount >= 0) {
      await this.client.query(
        `INSERT INTO variant_prices (organization_id, variant_id, amount_minor, currency, price_type, created_by)
         VALUES ($1, $2, $3, $4, 'cost', $5)`,
        [ctx.organizationId, variantId, costAmount * 100, currency, ctx.userId]
      );
    }
  }

  private async setImages(
    organizationId: string,
    productId: string,
    input: Record<string, unknown>
  ): Promise<void> {
    const fromPayload = Array.isArray(input.imageUris)
      ? input.imageUris.filter((value): value is string => typeof value === 'string')
      : [];
    const imageUris = fromPayload.length
      ? fromPayload
      : [text(input, 'imageUri')].filter((value): value is string => value !== undefined);
    let position = 0;
    for (const imageUri of imageUris) {
      if (!/^https?:\/\//i.test(imageUri)) continue;
      await this.setImage(organizationId, productId, imageUri, position++);
    }
  }

  private async setImage(
    organizationId: string,
    productId: string,
    imageUri: string,
    position: number
  ): Promise<void> {
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
      `UPDATE product_media SET is_primary = false WHERE organization_id = $1 AND product_id = $2 AND $3 = 0`,
      [organizationId, productId, position]
    );
    await this.client.query(
      `INSERT INTO product_media (organization_id, product_id, media_asset_id, role, position, is_primary)
       SELECT $1, $2, $3, 'gallery', $4, $5
       WHERE NOT EXISTS (SELECT 1 FROM product_media WHERE organization_id = $1 AND product_id = $2 AND media_asset_id = $3)`,
      [organizationId, productId, mediaId, position, position === 0]
    );
  }

  async catalogSnapshot(
    organizationId: string,
    productId: string,
    variantId: string
  ): Promise<Record<string, unknown>> {
    const result = await this.client.query(
      `SELECT p.id AS "productId", p.name AS "productName", p.slug, p.description, p.seo, p.features, p.model_3d_url AS "model3dUrl", p.active AS "productActive", p.published AS "productPublished",
              p.department_id AS "departmentId", d.name AS "departmentName",
              p.brand_id AS "brandId", b.name AS "brandName",
              p.primary_category_id AS "categoryId", c.name AS "categoryName", p.version AS "productVersion",
              v.id AS "variantId", v.sku, v.barcode, v.name AS "variantName", v.gender,
              v.current_price_amount AS "priceAmount",
              v.currency, v.attributes, v.active, v.published, v.version AS "variantVersion", media.public_url AS "imageUri",
              sale.amount_minor AS "salePriceAmount", sale.valid_from AS "saleValidFrom", sale.valid_until AS "saleValidUntil",
              cost.amount_minor AS "costAmount",
              COALESCE(inventory.quantity, 0) AS quantity, inventory.location_id AS "locationId",
              tag.id AS "tagId", tag.epc, tag.status AS "tagStatus"
       FROM products p JOIN product_variants v ON v.organization_id = p.organization_id AND v.product_id = p.id
       LEFT JOIN departments d ON d.id = p.department_id AND d.organization_id = p.organization_id AND d.deleted_at IS NULL
       LEFT JOIN brands b ON b.id = p.brand_id AND b.organization_id = p.organization_id AND b.deleted_at IS NULL
       LEFT JOIN categories c ON c.id = p.primary_category_id AND c.organization_id = p.organization_id AND c.deleted_at IS NULL
       LEFT JOIN LATERAL (SELECT ma.public_url FROM product_media pm JOIN media_assets ma ON ma.id = pm.media_asset_id
                          WHERE pm.organization_id = p.organization_id AND pm.product_id = p.id AND ma.status = 'ready'
                          ORDER BY pm.is_primary DESC, pm.position LIMIT 1) media ON true
       LEFT JOIN LATERAL (
         SELECT SUM(ib.quantity)::integer AS quantity, (array_agg(ib.location_id ORDER BY ib.updated_at DESC))[1] AS location_id
         FROM inventory_balances ib
         WHERE ib.organization_id = p.organization_id AND ib.variant_id = v.id
       ) inventory ON true
       LEFT JOIN LATERAL (
         SELECT amount_minor, valid_from, valid_until FROM variant_prices
         WHERE organization_id = p.organization_id AND variant_id = v.id AND price_type = 'sale'
         ORDER BY created_at DESC LIMIT 1
       ) sale ON true
       LEFT JOIN LATERAL (
         SELECT amount_minor FROM variant_prices
         WHERE organization_id = p.organization_id AND variant_id = v.id AND price_type = 'cost'
         ORDER BY created_at DESC LIMIT 1
       ) cost ON true
       LEFT JOIN LATERAL (
         SELECT t.id, t.epc, t.status
         FROM rfid_tags t
         LEFT JOIN inventory_items ii ON ii.id = t.inventory_item_id AND ii.deleted_at IS NULL
         WHERE t.organization_id = p.organization_id AND t.deleted_at IS NULL
           AND (t.variant_id = v.id OR ii.variant_id = v.id)
         ORDER BY t.updated_at DESC
         LIMIT 1
       ) tag ON true
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
    // Prices, inventory, media and RFID tags can change without incrementing
    // the variant row version. Include the canonical snapshot fingerprint so
    // those updates produce a new pull event instead of colliding with an
    // older `catalog:...:version` idempotency key.
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(snapshot))
      .digest('hex')
      .slice(0, 16);
    await new SyncRepository(this.client).appendServerEvent(ctx, {
      aggregateType: 'product_variant',
      aggregateId: variantId,
      operation,
      payload: { operationalSnapshot: snapshot },
      payloadVersion: 2,
      idempotencyKey: `catalog:${productId}:${variantId}:${operation}:${version}:${fingerprint}`
    });
  }
}
