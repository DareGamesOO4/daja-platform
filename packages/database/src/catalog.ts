/* eslint-disable @typescript-eslint/no-unsafe-return */
import type pg from 'pg';
import type { QueryResultRow } from 'pg';
import {
  ResourceConflictError,
  ResourceNotFoundError,
  TenantAccessDeniedError,
  ValidationFailedError,
  VersionConflictError
} from '@daja/security';
import type { RequestContext } from '@daja/shared';

export interface ProductRecord {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description: string | null;
  brandId: string | null;
  primaryCategoryId: string | null;
  active: boolean;
  published: boolean;
  legacyFirestoreId: string | null;
  externalId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface VariantRecord {
  id: string;
  organizationId: string;
  productId: string;
  sku: string;
  barcode: string | null;
  name: string | null;
  gender: string | null;
  currentPriceAmount: number;
  currency: string;
  attributes: Record<string, unknown>;
  active: boolean;
  published: boolean;
  version: number;
}

export class CatalogRepository {
  constructor(private readonly client: Pick<pg.Pool | pg.PoolClient, 'query'>) {}

  async listPublicProducts(
    ctx: Pick<RequestContext, 'organizationId'>,
    filters: {
      brand?: string | undefined;
      category?: string | undefined;
      gender?: string | undefined;
      minPrice?: number | undefined;
      maxPrice?: number | undefined;
      query?: string | undefined;
      cursor?: string | undefined;
      limit: number;
      sort?: string | undefined;
    }
  ): Promise<{ items: PublicProductCard[]; nextCursor: string | null }> {
    const params: unknown[] = [ctx.organizationId, filters.limit + 1];
    const where = [
      'p.organization_id = $1',
      'p.deleted_at IS NULL',
      'p.active',
      'p.published',
      'v.deleted_at IS NULL',
      'v.active',
      'v.published'
    ];
    if (filters.brand) {
      params.push(filters.brand);
      where.push(`b.slug = $${params.length}`);
    }
    if (filters.category) {
      params.push(filters.category);
      where.push(`c.slug = $${params.length}`);
    }
    if (filters.gender) {
      params.push(filters.gender);
      where.push(`v.gender = $${params.length}`);
    }
    if (filters.minPrice !== undefined) {
      params.push(filters.minPrice);
      where.push(`v.current_price_amount >= $${params.length}`);
    }
    if (filters.maxPrice !== undefined) {
      params.push(filters.maxPrice);
      where.push(`v.current_price_amount <= $${params.length}`);
    }
    if (filters.query) {
      params.push(`%${filters.query.trim().toLowerCase()}%`);
      where.push(
        `(p.normalized_name LIKE $${params.length} OR v.normalized_sku LIKE upper($${params.length}) OR b.normalized_name LIKE $${params.length})`
      );
    }
    const orderDirection = filters.sort === 'price_asc' ? 'ASC' : 'DESC';
    const cursor = decodeCursor(filters.cursor);
    if (cursor) {
      params.push(cursor.updatedAt, cursor.id);
      where.push(
        `(p.updated_at, p.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`
      );
    }

    const result = await this.client.query<PublicProductRow>(
      `SELECT p.id AS product_id, v.id AS variant_id, p.name, p.slug,
              b.name AS brand, c.name AS category,
              v.current_price_amount AS price, v.currency,
              COALESCE(inv.quantity, 0) AS available_quantity,
              primary_asset.public_url AS primary_image_url,
              thumb.public_url AS thumbnail_url,
              p.updated_at
       FROM products p
       JOIN LATERAL (
         SELECT *
         FROM product_variants pv
         WHERE pv.product_id = p.id AND pv.organization_id = p.organization_id
           AND pv.deleted_at IS NULL AND pv.active AND pv.published
         ORDER BY pv.current_price_amount ${orderDirection}, pv.id
         LIMIT 1
       ) v ON true
       LEFT JOIN brands b ON b.id = p.brand_id AND b.organization_id = p.organization_id AND b.deleted_at IS NULL
       LEFT JOIN categories c ON c.id = p.primary_category_id AND c.organization_id = p.organization_id AND c.deleted_at IS NULL
       LEFT JOIN LATERAL (
         SELECT SUM(quantity)::integer AS quantity
         FROM inventory_balances ib
         WHERE ib.organization_id = p.organization_id AND ib.variant_id = v.id
       ) inv ON true
       LEFT JOIN LATERAL (
         SELECT ma.public_url
         FROM product_media pm
         JOIN media_assets ma ON ma.id = pm.media_asset_id AND ma.status = 'ready'
         WHERE pm.organization_id = p.organization_id AND pm.product_id = p.id
         ORDER BY pm.is_primary DESC, pm.position ASC, pm.id
         LIMIT 1
       ) primary_asset ON true
       LEFT JOIN LATERAL (
         SELECT md.public_url
         FROM product_media pm
         JOIN media_derivatives md ON md.media_asset_id = pm.media_asset_id
         WHERE pm.organization_id = p.organization_id AND pm.product_id = p.id
         ORDER BY pm.is_primary DESC, pm.position ASC, md.width ASC
         LIMIT 1
       ) thumb ON true
       WHERE ${where.join(' AND ')}
       ORDER BY p.updated_at DESC, p.id DESC
       LIMIT $2`,
      params
    );
    const rows = result.rows.slice(0, filters.limit);
    const lastRow = rows.at(-1);
    return {
      items: rows.map(mapPublicProduct),
      nextCursor: result.rows.length > filters.limit && lastRow ? encodeCursor(lastRow) : null
    };
  }

  async getPublicProductBySlug(ctx: Pick<RequestContext, 'organizationId'>, slug: string) {
    const result = await this.client.query(
      `SELECT p.*, b.name AS brand_name, c.name AS category_name,
              COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.current_price_amount) FILTER (WHERE v.id IS NOT NULL), '[]'::jsonb) AS variants
       FROM products p
       LEFT JOIN brands b ON b.id = p.brand_id AND b.organization_id = p.organization_id
       LEFT JOIN categories c ON c.id = p.primary_category_id AND c.organization_id = p.organization_id
       LEFT JOIN product_variants v ON v.product_id = p.id AND v.organization_id = p.organization_id
         AND v.deleted_at IS NULL AND v.active AND v.published
       WHERE p.organization_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL AND p.active AND p.published
       GROUP BY p.id, b.name, c.name`,
      [ctx.organizationId, slug]
    );
    return result.rows[0] ?? null;
  }

  async listBrands(ctx: Pick<RequestContext, 'organizationId'>) {
    const result = await this.client.query(
      `SELECT id, name, slug, active, version
       FROM brands
       WHERE organization_id = $1 AND deleted_at IS NULL AND active
       ORDER BY normalized_name`,
      [ctx.organizationId]
    );
    return result.rows;
  }

  async listCategories(ctx: Pick<RequestContext, 'organizationId'>) {
    const result = await this.client.query(
      `SELECT id, parent_id AS "parentId", name, slug, sort_order AS "sortOrder", active, version
       FROM categories
       WHERE organization_id = $1 AND deleted_at IS NULL AND active
       ORDER BY parent_id NULLS FIRST, sort_order, name`,
      [ctx.organizationId]
    );
    return result.rows;
  }

  async createProduct(
    ctx: RequestContext,
    input: {
      name: string;
      slug: string;
      description?: string | null | undefined;
      brandId?: string | null | undefined;
      primaryCategoryId?: string | null | undefined;
      published?: boolean | undefined;
      active?: boolean | undefined;
      legacyFirestoreId?: string | null | undefined;
      externalId?: string | null | undefined;
    }
  ): Promise<ProductRecord> {
    await this.assertOptionalTenantRefs(ctx.organizationId, input.brandId, input.primaryCategoryId);
    try {
      const result = await this.client.query<ProductRow>(
        `INSERT INTO products (organization_id, name, slug, description, brand_id, primary_category_id, active, published, legacy_firestore_id, external_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          ctx.organizationId,
          input.name,
          input.slug,
          input.description ?? null,
          input.brandId ?? null,
          input.primaryCategoryId ?? null,
          input.active ?? true,
          input.published ?? false,
          input.legacyFirestoreId ?? null,
          input.externalId ?? null
        ]
      );
      return mapProduct(requireRow(result));
    } catch (error) {
      throwConflictForUnique(error, 'Product slug, legacy id, or external id already exists');
    }
  }

  async getProduct(
    ctx: Pick<RequestContext, 'organizationId'>,
    id: string
  ): Promise<ProductRecord> {
    const result = await this.client.query<ProductRow>(
      `SELECT * FROM products WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.organizationId, id]
    );
    if (result.rowCount !== 1) {
      throw new TenantAccessDeniedError();
    }
    return mapProduct(requireRow(result));
  }

  async patchProduct(
    ctx: Pick<RequestContext, 'organizationId'>,
    id: string,
    input: Partial<{
      expectedVersion: number | undefined;
      name: string | undefined;
      slug: string | undefined;
      description: string | null | undefined;
      brandId: string | null | undefined;
      primaryCategoryId: string | null | undefined;
      active: boolean | undefined;
      published: boolean | undefined;
    }>
  ): Promise<ProductRecord> {
    if (input.brandId !== undefined || input.primaryCategoryId !== undefined) {
      await this.assertOptionalTenantRefs(
        ctx.organizationId,
        input.brandId,
        input.primaryCategoryId
      );
    }
    const current = await this.getProduct(ctx, id);
    if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      throw new VersionConflictError();
    }
    const next = { ...current, ...input };
    try {
      const result = await this.client.query<ProductRow>(
        `UPDATE products
         SET name = $3, slug = $4, description = $5, brand_id = $6, primary_category_id = $7,
             active = $8, published = $9, version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
         RETURNING *`,
        [
          ctx.organizationId,
          id,
          next.name,
          next.slug,
          next.description,
          next.brandId,
          next.primaryCategoryId,
          next.active,
          next.published
        ]
      );
      return mapProduct(requireRow(result));
    } catch (error) {
      throwConflictForUnique(error, 'Product slug already exists');
    }
  }

  async softDeleteProduct(ctx: Pick<RequestContext, 'organizationId'>, id: string): Promise<void> {
    const result = await this.client.query(
      `UPDATE products
       SET deleted_at = now(), active = false, published = false, version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.organizationId, id]
    );
    if (result.rowCount !== 1) {
      throw new TenantAccessDeniedError();
    }
  }

  async createVariant(
    ctx: RequestContext,
    productId: string,
    input: {
      sku: string;
      barcode?: string | null | undefined;
      name?: string | null | undefined;
      gender?: string | null | undefined;
      currentPriceAmount: number;
      currency: string;
      attributes?: Record<string, unknown> | undefined;
      active?: boolean | undefined;
      published?: boolean | undefined;
    }
  ): Promise<VariantRecord> {
    await this.getProduct(ctx, productId);
    try {
      const result = await this.client.query<VariantRow>(
        `INSERT INTO product_variants (organization_id, product_id, sku, barcode, name, gender, current_price_amount, currency, attributes, active, published)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
         RETURNING *`,
        [
          ctx.organizationId,
          productId,
          input.sku,
          input.barcode ?? null,
          input.name ?? null,
          input.gender ?? null,
          input.currentPriceAmount,
          input.currency,
          JSON.stringify(input.attributes ?? {}),
          input.active ?? true,
          input.published ?? false
        ]
      );
      const variant = mapVariant(requireRow(result));
      await this.client.query(
        `INSERT INTO variant_prices (organization_id, variant_id, amount_minor, currency, price_type, created_by)
         VALUES ($1, $2, $3, $4, 'sell', $5)`,
        [ctx.organizationId, variant.id, variant.currentPriceAmount, variant.currency, ctx.userId]
      );
      return variant;
    } catch (error) {
      throwConflictForUnique(error, 'Variant SKU or barcode already exists');
    }
  }

  async patchVariant(
    ctx: RequestContext,
    id: string,
    input: Partial<{
      expectedVersion: number | undefined;
      sku: string | undefined;
      barcode: string | null | undefined;
      name: string | null | undefined;
      gender: string | null | undefined;
      currentPriceAmount: number | undefined;
      currency: string | undefined;
      attributes: Record<string, unknown> | undefined;
      active: boolean | undefined;
      published: boolean | undefined;
    }>
  ): Promise<{ before: VariantRecord; after: VariantRecord; priceChanged: boolean }> {
    const before = await this.getVariant(ctx, id);
    if (input.expectedVersion !== undefined && before.version !== input.expectedVersion) {
      throw new VersionConflictError();
    }
    const next = { ...before, ...input };
    const priceChanged =
      input.currentPriceAmount !== undefined &&
      input.currentPriceAmount !== before.currentPriceAmount;
    try {
      const result = await this.client.query<VariantRow>(
        `UPDATE product_variants
         SET sku = $3, barcode = $4, name = $5, gender = $6, current_price_amount = $7,
             currency = $8, attributes = $9::jsonb, active = $10, published = $11,
             version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
         RETURNING *`,
        [
          ctx.organizationId,
          id,
          next.sku,
          next.barcode,
          next.name,
          next.gender,
          next.currentPriceAmount,
          next.currency,
          JSON.stringify(next.attributes),
          next.active,
          next.published
        ]
      );
      const after = mapVariant(requireRow(result));
      if (priceChanged) {
        await this.client.query(
          `UPDATE variant_prices
           SET valid_until = now()
           WHERE organization_id = $1 AND variant_id = $2 AND price_type = 'sell' AND valid_until IS NULL`,
          [ctx.organizationId, id]
        );
        await this.client.query(
          `INSERT INTO variant_prices (organization_id, variant_id, amount_minor, currency, price_type, created_by)
           VALUES ($1, $2, $3, $4, 'sell', $5)`,
          [ctx.organizationId, id, after.currentPriceAmount, after.currency, ctx.userId]
        );
      }
      return { before, after, priceChanged };
    } catch (error) {
      throwConflictForUnique(error, 'Variant SKU or barcode already exists');
    }
  }

  async getVariant(
    ctx: Pick<RequestContext, 'organizationId'>,
    id: string
  ): Promise<VariantRecord> {
    const result = await this.client.query<VariantRow>(
      `SELECT * FROM product_variants WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.organizationId, id]
    );
    if (result.rowCount !== 1) {
      throw new TenantAccessDeniedError();
    }
    return mapVariant(requireRow(result));
  }

  private async assertOptionalTenantRefs(
    organizationId: string,
    brandId: string | null | undefined,
    categoryId: string | null | undefined
  ): Promise<void> {
    if (brandId) {
      const result = await this.client.query(
        `SELECT 1 FROM brands WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [organizationId, brandId]
      );
      if (result.rowCount !== 1) {
        throw new ValidationFailedError('Brand does not belong to organization');
      }
    }
    if (categoryId) {
      const result = await this.client.query(
        `SELECT 1 FROM categories WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [organizationId, categoryId]
      );
      if (result.rowCount !== 1) {
        throw new ValidationFailedError('Category does not belong to organization');
      }
    }
  }
}

export interface PublicProductCard {
  productId: string;
  variantId: string;
  name: string;
  slug: string;
  brand: string | null;
  category: string | null;
  price: number;
  currency: string;
  availability: { inStock: boolean; availableQuantity: number };
  primaryImageUrl: string | null;
  thumbnailUrl: string | null;
}

interface PublicProductRow {
  product_id: string;
  variant_id: string;
  name: string;
  slug: string;
  brand: string | null;
  category: string | null;
  price: number;
  currency: string;
  available_quantity: number | null;
  primary_image_url: string | null;
  thumbnail_url: string | null;
  updated_at: Date;
}

interface ProductRow {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  description: string | null;
  brand_id: string | null;
  primary_category_id: string | null;
  active: boolean;
  published: boolean;
  legacy_firestore_id: string | null;
  external_id: string | null;
  version: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

interface VariantRow {
  id: string;
  organization_id: string;
  product_id: string;
  sku: string;
  barcode: string | null;
  name: string | null;
  gender: string | null;
  current_price_amount: number;
  currency: string;
  attributes: Record<string, unknown>;
  active: boolean;
  published: boolean;
  version: string;
}

function requireRow<T extends QueryResultRow>(result: pg.QueryResult<T>): T {
  const row = result.rows[0];
  if (!row) {
    throw new ResourceNotFoundError('database row');
  }
  return row;
}

function mapProduct(row: ProductRow): ProductRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    brandId: row.brand_id,
    primaryCategoryId: row.primary_category_id,
    active: row.active,
    published: row.published,
    legacyFirestoreId: row.legacy_firestore_id,
    externalId: row.external_id,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

function mapVariant(row: VariantRow): VariantRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    productId: row.product_id,
    sku: row.sku,
    barcode: row.barcode,
    name: row.name,
    gender: row.gender,
    currentPriceAmount: row.current_price_amount,
    currency: row.currency,
    attributes: row.attributes,
    active: row.active,
    published: row.published,
    version: Number(row.version)
  };
}

function mapPublicProduct(row: PublicProductRow): PublicProductCard {
  const availableQuantity = row.available_quantity ?? 0;
  return {
    productId: row.product_id,
    variantId: row.variant_id,
    name: row.name,
    slug: row.slug,
    brand: row.brand,
    category: row.category,
    price: row.price,
    currency: row.currency,
    availability: { inStock: availableQuantity > 0, availableQuantity },
    primaryImageUrl: row.primary_image_url,
    thumbnailUrl: row.thumbnail_url
  };
}

function encodeCursor(row: PublicProductRow): string {
  return Buffer.from(
    JSON.stringify({ updatedAt: row.updated_at.toISOString(), id: row.product_id })
  ).toString('base64url');
}

function decodeCursor(cursor: string | undefined): { updatedAt: string; id: string } | null {
  if (!cursor) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      updatedAt: string;
      id: string;
    };
    return parsed.updatedAt && parsed.id ? parsed : null;
  } catch {
    throw new ValidationFailedError('Invalid cursor');
  }
}

function throwConflictForUnique(error: unknown, message: string): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
    throw new ResourceConflictError(message);
  }
  throw error;
}
