/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import type pg from 'pg';
import { createSign } from 'node:crypto';
import ExcelJS from 'exceljs';
import { ValidationFailedError } from '@daja/security';
import type { RequestContext } from '@daja/shared';

export interface NormalizedImportRow {
  sourceId: string;
  name: string;
  slug?: string;
  brand?: string;
  department?: string;
  category?: string;
  gender?: string;
  priceMinor: number;
  imageUrls: string[];
  description?: string;
  specs: Record<string, string | number | boolean>;
}

export class ImportRepository {
  constructor(private readonly client: Pick<pg.Pool | pg.PoolClient, 'query'>) {}

  async createXlsxJob(
    ctx: RequestContext,
    input: { sourceName: string; buffer: Buffer; dryRun: boolean }
  ) {
    const rows = await parseXlsxRows(input.buffer);
    const job = await this.client.query<{ id: string }>(
      `INSERT INTO import_jobs (organization_id, source_type, status, dry_run, source_name, created_by)
       VALUES ($1, 'xlsx', 'validated', $2, $3, $4)
       RETURNING id`,
      [ctx.organizationId, input.dryRun, input.sourceName, ctx.userId]
    );
    const createdJob = job.rows[0];
    if (!createdJob) {
      throw new Error('Import job insert did not return an id');
    }
    const jobId = createdJob.id;
    let valid = 0;
    let invalid = 0;
    for (const [index, raw] of rows.entries()) {
      const normalized = normalizeWebshopRow(raw);
      if (normalized.errors.length === 0) {
        valid += 1;
      } else {
        invalid += 1;
      }
      await this.client.query(
        `INSERT INTO import_rows (organization_id, import_job_id, row_number, source_id, status, raw_payload, normalized_payload, warnings, errors)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)`,
        [
          ctx.organizationId,
          jobId,
          index + 2,
          normalized.value?.sourceId ?? raw.ID?.toString() ?? null,
          normalized.errors.length === 0 ? 'valid' : 'invalid',
          JSON.stringify(raw),
          JSON.stringify(normalized.value ?? {}),
          JSON.stringify(normalized.warnings),
          JSON.stringify(normalized.errors)
        ]
      );
    }
    await this.client.query(
      `UPDATE import_jobs
       SET summary = $3::jsonb, updated_at = now()
       WHERE organization_id = $1 AND id = $2`,
      [
        ctx.organizationId,
        jobId,
        JSON.stringify({ sourceRows: rows.length, validRows: valid, invalidRows: invalid })
      ]
    );
    return {
      jobId,
      sourceRows: rows.length,
      validRows: valid,
      invalidRows: invalid,
      dryRun: input.dryRun
    };
  }

  async executeJob(ctx: RequestContext, jobId: string) {
    const job = await this.client.query(
      `SELECT * FROM import_jobs WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.organizationId, jobId]
    );
    const jobRow = job.rows[0];
    if (!jobRow) {
      throw new ValidationFailedError('Import job not found');
    }
    const rows = await this.client.query(
      `SELECT id, normalized_payload
       FROM import_rows
       WHERE organization_id = $1 AND import_job_id = $2 AND status IN ('valid', 'imported')
       ORDER BY row_number`,
      [ctx.organizationId, jobId]
    );
    if (jobRow.dry_run) {
      await this.client.query(
        `UPDATE import_jobs SET status = 'dry_run', updated_at = now() WHERE organization_id = $1 AND id = $2`,
        [ctx.organizationId, jobId]
      );
      return { jobId, dryRun: true, wouldImportRows: rows.rowCount };
    }
    let imported = 0;
    for (const row of rows.rows as Array<{ id: string; normalized_payload: NormalizedImportRow }>) {
      const payload = row.normalized_payload;
      const product = await this.upsertImportedProduct(ctx, payload, jobRow.source_type);
      const variant = await this.upsertImportedVariant(ctx, product.id, payload);
      await this.client.query(
        `UPDATE import_rows
         SET status = 'imported', target_product_id = $3, target_variant_id = $4
         WHERE organization_id = $1 AND id = $2`,
        [ctx.organizationId, row.id, product.id, variant.id]
      );
      imported += 1;
    }
    await this.client.query(
      `UPDATE import_jobs
       SET status = 'completed', summary = summary || $3::jsonb, updated_at = now()
       WHERE organization_id = $1 AND id = $2`,
      [ctx.organizationId, jobId, JSON.stringify({ importedRows: imported })]
    );
    return { jobId, dryRun: false, importedRows: imported };
  }

  private async upsertImportedProduct(
    ctx: RequestContext,
    payload: NormalizedImportRow,
    sourceType: string
  ) {
    const slug = payload.slug
      ? slugify(payload.slug)
      : slugify(`${payload.sourceId}-${payload.name}`);
    const conflictColumn = sourceType === 'firestore' ? 'legacy_firestore_id' : 'external_id';
    const legacyFirestoreId = sourceType === 'firestore' ? payload.sourceId : null;
    const externalId = sourceType === 'firestore' ? null : payload.sourceId;
    const brandId = payload.brand ? await this.upsertImportedBrand(ctx, payload.brand) : null;
    const categoryId = payload.category
      ? await this.upsertImportedCategory(ctx, payload.category)
      : null;
    const result = await this.client.query<{ id: string; slug: string }>(
      `INSERT INTO products (organization_id, name, slug, description, brand_id, primary_category_id, legacy_firestore_id, external_id, published)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (organization_id, ${conflictColumn}) WHERE ${conflictColumn} IS NOT NULL AND deleted_at IS NULL
       DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         brand_id = EXCLUDED.brand_id,
         primary_category_id = EXCLUDED.primary_category_id,
         published = EXCLUDED.published,
         version = products.version + 1,
         updated_at = now()
       RETURNING id, slug`,
      [
        ctx.organizationId,
        payload.name,
        slug,
        payload.description ?? null,
        brandId,
        categoryId,
        legacyFirestoreId,
        externalId,
        sourceType === 'firestore'
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Imported product upsert did not return a row');
    }
    return row;
  }

  private async upsertImportedBrand(ctx: Pick<RequestContext, 'organizationId'>, name: string) {
    const slug = slugify(name);
    const result = await this.client.query<{ id: string }>(
      `INSERT INTO brands (organization_id, name, slug, active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (organization_id, slug) WHERE deleted_at IS NULL
       DO UPDATE SET name = EXCLUDED.name, active = true, updated_at = now(), version = brands.version + 1
       RETURNING id`,
      [ctx.organizationId, name, slug]
    );
    return requireReturnedId(result, 'brand');
  }

  private async upsertImportedCategory(ctx: Pick<RequestContext, 'organizationId'>, name: string) {
    const slug = slugify(name);
    const result = await this.client.query<{ id: string }>(
      `INSERT INTO categories (organization_id, name, slug, active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (organization_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), slug) WHERE deleted_at IS NULL
       DO UPDATE SET name = EXCLUDED.name, active = true, updated_at = now(), version = categories.version + 1
       RETURNING id`,
      [ctx.organizationId, name, slug]
    );
    return requireReturnedId(result, 'category');
  }

  private async upsertImportedVariant(
    ctx: RequestContext,
    productId: string,
    payload: NormalizedImportRow
  ) {
    const existing = await this.client.query<{ id: string; current_price_amount: number }>(
      `SELECT id, current_price_amount
       FROM product_variants
       WHERE organization_id = $1 AND normalized_sku = upper($2) AND deleted_at IS NULL
       FOR UPDATE`,
      [ctx.organizationId, payload.sourceId]
    );
    const existingRow = existing.rows[0];
    const result = await this.client.query<{ id: string }>(
      `INSERT INTO product_variants (organization_id, product_id, sku, gender, current_price_amount, currency, attributes, published)
       VALUES ($1, $2, $3, $4, $5, 'RSD', $6::jsonb, true)
       ON CONFLICT (organization_id, normalized_sku) WHERE deleted_at IS NULL
       DO UPDATE SET
         product_id = EXCLUDED.product_id,
         gender = EXCLUDED.gender,
         current_price_amount = EXCLUDED.current_price_amount,
         attributes = EXCLUDED.attributes,
         published = EXCLUDED.published,
         version = product_variants.version + 1,
         updated_at = now()
       RETURNING id`,
      [
        ctx.organizationId,
        productId,
        payload.sourceId,
        payload.gender ?? null,
        payload.priceMinor,
        JSON.stringify(payload.specs)
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Imported variant upsert did not return a row');
    }
    if (!existingRow || existingRow.current_price_amount !== payload.priceMinor) {
      if (existingRow) {
        await this.client.query(
          `UPDATE variant_prices
           SET valid_until = now()
           WHERE organization_id = $1 AND variant_id = $2 AND price_type = 'sell' AND valid_until IS NULL`,
          [ctx.organizationId, row.id]
        );
      }
      await this.client.query(
        `INSERT INTO variant_prices (organization_id, variant_id, amount_minor, currency, price_type, created_by)
         VALUES ($1, $2, $3, 'RSD', 'sell', $4)`,
        [ctx.organizationId, row.id, payload.priceMinor, ctx.userId]
      );
    }
    await this.syncImportedMedia(ctx, productId, payload.imageUrls);
    return row;
  }

  private async syncImportedMedia(
    ctx: Pick<RequestContext, 'organizationId'>,
    productId: string,
    imageUrls: string[]
  ): Promise<void> {
    const originals = imageUrls.filter((url) => !isThumbnailUrl(url));
    const thumbnails = imageUrls.filter(isThumbnailUrl);
    await this.client.query(
      `DELETE FROM product_media WHERE organization_id = $1 AND product_id = $2`,
      [ctx.organizationId, productId]
    );
    for (const [index, url] of originals.entries()) {
      const storageKey = storageKeyFromPublicUrl(url);
      const mediaId = await this.upsertImportedMediaAsset(ctx, {
        storageKey,
        publicUrl: url,
        role: 'original'
      });
      const thumbUrl = findThumbnailForOriginal(url, imageUrls, thumbnails);
      if (thumbUrl) {
        await this.upsertImportedDerivative(ctx, mediaId, thumbUrl);
      }
      await this.client.query(
        `INSERT INTO product_media (organization_id, product_id, media_asset_id, role, position, is_primary)
         VALUES ($1, $2, $3, 'gallery', $4, $5)`,
        [ctx.organizationId, productId, mediaId, index, index === 0]
      );
    }
  }

  private async upsertImportedMediaAsset(
    ctx: Pick<RequestContext, 'organizationId'>,
    input: { storageKey: string; publicUrl: string; role: string }
  ): Promise<string> {
    const result = await this.client.query<{ id: string }>(
      `INSERT INTO media_assets (
         organization_id, storage_provider, storage_bucket, storage_key, public_url,
         mime_type, status, metadata
       )
       VALUES ($1, 'r2', 'dajashop-images', $2, $3, 'image/webp', 'ready', $4::jsonb)
       ON CONFLICT (organization_id, storage_bucket, storage_key) WHERE deleted_at IS NULL
       DO UPDATE SET
         public_url = EXCLUDED.public_url,
         mime_type = EXCLUDED.mime_type,
         status = 'ready',
         metadata = media_assets.metadata || EXCLUDED.metadata,
         updated_at = now(),
         version = media_assets.version + 1
       RETURNING id`,
      [
        ctx.organizationId,
        input.storageKey,
        input.publicUrl,
        JSON.stringify({ sourceSystem: 'firestore', role: input.role })
      ]
    );
    return requireReturnedId(result, 'media asset');
  }

  private async upsertImportedDerivative(
    ctx: Pick<RequestContext, 'organizationId'>,
    mediaId: string,
    thumbUrl: string
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO media_derivatives (
         organization_id, media_asset_id, width, height, mime_type, storage_key, public_url, size_bytes
       )
       VALUES ($1, $2, 512, 512, 'image/webp', $3, $4, 0)
       ON CONFLICT (media_asset_id, width)
       DO UPDATE SET
         height = EXCLUDED.height,
         mime_type = EXCLUDED.mime_type,
         storage_key = EXCLUDED.storage_key,
         public_url = EXCLUDED.public_url,
         size_bytes = EXCLUDED.size_bytes`,
      [ctx.organizationId, mediaId, storageKeyFromPublicUrl(thumbUrl), thumbUrl]
    );
  }

  async reconciliation(ctx: Pick<RequestContext, 'organizationId'>, jobId: string) {
    const result = await this.client.query(
      `SELECT
         COUNT(*)::integer AS "sourceProductCount",
         COUNT(target_product_id)::integer AS "targetProductCount",
         COUNT(*) FILTER (WHERE status = 'imported')::integer AS "productsImported",
         COUNT(*) FILTER (WHERE status = 'skipped')::integer AS "productsSkipped",
         COUNT(*) FILTER (WHERE errors ? 'Invalid Cena' OR errors ? 'Invalid price')::integer AS "invalidPrices",
         COUNT(*) FILTER (WHERE warnings ? 'Missing image')::integer AS "missingImages",
         COUNT(*) FILTER (WHERE jsonb_array_length(errors) > 0)::integer AS "failedRows",
         COALESCE(jsonb_agg(DISTINCT source_id) FILTER (
           WHERE source_id IN (
             SELECT source_id
             FROM import_rows
             WHERE organization_id = $1 AND import_job_id = $2 AND source_id IS NOT NULL
             GROUP BY source_id
             HAVING count(*) > 1
           )
         ), '[]'::jsonb) AS "duplicateLegacyIds",
         COALESCE(jsonb_agg(DISTINCT normalized_payload->>'sourceId') FILTER (
           WHERE normalized_payload->>'sourceId' IN (
             SELECT normalized_payload->>'sourceId'
             FROM import_rows
             WHERE organization_id = $1 AND import_job_id = $2 AND normalized_payload ? 'sourceId'
             GROUP BY normalized_payload->>'sourceId'
             HAVING count(*) > 1
           )
         ), '[]'::jsonb) AS "duplicateSkus",
         COALESCE(jsonb_agg(DISTINCT raw_payload->>'Slika') FILTER (WHERE raw_payload ? 'Slika'), '[]'::jsonb) AS "imageUrlDomains",
         COUNT(*) FILTER (WHERE NOT (normalized_payload ? 'brand') OR NOT (normalized_payload ? 'category'))::integer AS "brandCategoryMappingIssues"
       FROM import_rows
       WHERE organization_id = $1 AND import_job_id = $2`,
      [ctx.organizationId, jobId]
    );
    return result.rows[0];
  }

  async createFirestoreJob(
    ctx: RequestContext,
    input: {
      sourceName: string;
      dryRun: boolean;
      checkpoint?: Record<string, unknown> | undefined;
      projectId?: string | undefined;
      serviceAccountJson?: string | undefined;
      collection?: string | undefined;
      documentId?: string | undefined;
      batchSize?: number | undefined;
    }
  ) {
    const result = await this.client.query<{ id: string }>(
      `INSERT INTO import_jobs (organization_id, source_type, status, dry_run, source_name, checkpoint, created_by, summary)
       VALUES ($1, 'firestore', 'uploaded', $2, $3, $4::jsonb, $5, $6::jsonb)
       RETURNING id`,
      [
        ctx.organizationId,
        input.dryRun,
        input.sourceName,
        JSON.stringify(input.checkpoint ?? {}),
        ctx.userId,
        JSON.stringify({
          note: input.serviceAccountJson
            ? 'Firestore read-only import initialized.'
            : 'Firestore tool is read-only; execution requires service-account credentials supplied at runtime.'
        })
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Firestore import job insert did not return an id');
    }
    if (!input.serviceAccountJson || !input.projectId) {
      return { jobId: row.id, dryRun: input.dryRun, credentialsRequired: true };
    }
    const documents = await readFirestoreProducts(input);
    let valid = 0;
    let invalid = 0;
    for (const [index, document] of documents.entries()) {
      const normalized = normalizeFirestoreDocument(document);
      if (normalized.errors.length === 0) {
        valid += 1;
      } else {
        invalid += 1;
      }
      await this.client.query(
        `INSERT INTO import_rows (organization_id, import_job_id, row_number, source_id, status, raw_payload, normalized_payload, warnings, errors)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)`,
        [
          ctx.organizationId,
          row.id,
          index + 1,
          document.id,
          normalized.errors.length === 0 ? 'valid' : 'invalid',
          JSON.stringify(document.raw),
          JSON.stringify(normalized.value ?? {}),
          JSON.stringify(normalized.warnings),
          JSON.stringify(normalized.errors)
        ]
      );
    }
    await this.client.query(
      `UPDATE import_jobs
       SET status = 'validated', summary = $3::jsonb, checkpoint = $4::jsonb, updated_at = now()
       WHERE organization_id = $1 AND id = $2`,
      [
        ctx.organizationId,
        row.id,
        JSON.stringify({ sourceRows: documents.length, validRows: valid, invalidRows: invalid }),
        JSON.stringify({ nextPageToken: documents.at(-1)?.nextPageToken ?? null })
      ]
    );
    return {
      jobId: row.id,
      dryRun: input.dryRun,
      sourceRows: documents.length,
      validRows: valid,
      invalidRows: invalid
    };
  }
}

async function parseXlsxRows(buffer: Uint8Array): Promise<Array<Record<string, unknown>>> {
  const workbook = new ExcelJS.Workbook();
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;
  const workbookBuffer = Buffer.from(arrayBuffer) as unknown as Parameters<
    typeof workbook.xlsx.load
  >[0];
  await workbook.xlsx.load(workbookBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new ValidationFailedError('XLSX workbook has no sheets');
  }
  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell((cell, colNumber) => {
    headers[colNumber] = cellToString(cell.value);
  });
  const rows: Array<Record<string, unknown>> = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) {
      return;
    }
    const output: Record<string, unknown> = {};
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const header = headers[colNumber];
      if (header) {
        output[header] = cellToString(cell.value);
      }
    });
    if (Object.values(output).some((value) => value !== '')) {
      rows.push(output);
    }
  });
  return rows;
}

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') {
      return value.text.trim();
    }
    if ('result' in value) {
      return primitiveToString(value.result);
    }
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText
        .map((part) => part.text)
        .join('')
        .trim();
    }
  }
  return primitiveToString(value);
}

function primitiveToString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return '';
}

function normalizeWebshopRow(raw: Record<string, unknown>): {
  value?: NormalizedImportRow;
  warnings: string[];
  errors: string[];
} {
  const warnings: string[] = [];
  const errors: string[] = [];
  const sourceId = stringField(raw.ID);
  const name = stringField(raw.Naziv);
  const price = Number(
    stringField(raw.Cena)
      .replace(/[^\d.,-]/g, '')
      .replace(',', '.')
  );
  if (!sourceId) errors.push('Missing ID');
  if (!name) errors.push('Missing Naziv');
  if (!Number.isFinite(price) || price < 0) errors.push('Invalid Cena');
  const image = stringField(raw.Slika);
  if (!image) warnings.push('Missing image');
  const specs: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('Spec:') && value !== '') {
      specs[slugify(key.slice(5)).replace(/-/g, '_')] = stringField(value);
    }
  }
  if (errors.length > 0) {
    return { warnings, errors };
  }
  const value: NormalizedImportRow = {
    sourceId,
    name,
    priceMinor: Math.round(price * 100),
    imageUrls: image ? [image] : [],
    specs
  };
  const brand = stringField(raw.Brend);
  const department = stringField(raw.Odeljenje);
  const category = stringField(raw.Kategorija);
  const gender = stringField(raw.Pol);
  const description = stringField(raw.Opis);
  if (brand) value.brand = brand;
  if (department) value.department = department;
  if (category) value.category = category;
  if (gender) value.gender = gender;
  if (description) value.description = description;
  return {
    warnings,
    errors,
    value
  };
}

interface FirestoreDocument {
  id: string;
  raw: Record<string, unknown>;
  nextPageToken?: string | undefined;
}

async function readFirestoreProducts(input: {
  projectId?: string | undefined;
  serviceAccountJson?: string | undefined;
  collection?: string | undefined;
  documentId?: string | undefined;
  batchSize?: number | undefined;
}): Promise<FirestoreDocument[]> {
  if (!input.projectId || !input.serviceAccountJson) {
    throw new ValidationFailedError('Firestore credentials are required');
  }
  const token = await createGoogleAccessToken(input.serviceAccountJson);
  const collection = input.collection ?? 'products';
  const batchSize = Math.min(Math.max(input.batchSize ?? 100, 1), 500);
  const base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(input.projectId)}/databases/(default)/documents/${encodeURIComponent(collection)}`;
  const url = input.documentId
    ? `${base}/${encodeURIComponent(input.documentId)}`
    : `${base}?pageSize=${batchSize}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new ValidationFailedError('Firestore read failed', {
      status: response.status,
      body: await response.text()
    });
  }
  const payload = (await response.json()) as {
    name?: string;
    fields?: Record<string, FirestoreValue>;
    documents?: Array<{ name: string; fields?: Record<string, FirestoreValue> }>;
    nextPageToken?: string;
  };
  const documents =
    payload.documents ??
    (payload.name ? [payload as { name: string; fields?: Record<string, FirestoreValue> }] : []);
  return documents.map((document) => ({
    id: document.name.split('/').at(-1) ?? document.name,
    raw: decodeFirestoreFields(document.fields ?? {}),
    ...(payload.nextPageToken ? { nextPageToken: payload.nextPageToken } : {})
  }));
}

async function createGoogleAccessToken(serviceAccountJson: string): Promise<string> {
  const serviceAccount = JSON.parse(serviceAccountJson) as {
    client_email?: string;
    private_key?: string;
    token_uri?: string;
  };
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new ValidationFailedError('Invalid Firestore service account JSON');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64Url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/datastore',
      aud: serviceAccount.token_uri ?? 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    })
  );
  const unsigned = `${header}.${claim}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(serviceAccount.private_key);
  const assertion = `${unsigned}.${base64Url(signature)}`;
  const response = await fetch(serviceAccount.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  if (!response.ok) {
    throw new ValidationFailedError('Firestore auth failed', {
      status: response.status,
      body: await response.text()
    });
  }
  const token = (await response.json()) as { access_token?: string };
  if (!token.access_token) {
    throw new ValidationFailedError('Firestore auth did not return an access token');
  }
  return token.access_token;
}

function normalizeFirestoreDocument(document: FirestoreDocument): {
  value?: NormalizedImportRow;
  warnings: string[];
  errors: string[];
} {
  const raw = document.raw;
  const sourceId = document.id;
  const name = stringField(raw.Naziv) || stringField(raw.name) || stringField(raw.title);
  const price = Number(
    (stringField(raw.Cena) || stringField(raw.price)).replace(/[^\d.,-]/g, '').replace(',', '.')
  );
  const warnings: string[] = [];
  const errors: string[] = [];
  if (!sourceId) errors.push('Missing Firestore document id');
  if (!name) errors.push('Missing product name');
  if (!Number.isFinite(price) || price < 0) errors.push('Invalid price');
  const images = collectFirestoreImages(raw);
  if (images.length === 0) warnings.push('Missing image');
  if (errors.length > 0) {
    return { warnings, errors };
  }
  const value: NormalizedImportRow = {
    sourceId,
    name,
    ...(stringField(raw.slug) ? { slug: stringField(raw.slug) } : {}),
    priceMinor: Math.round(price * 100),
    imageUrls: images,
    specs: collectFirestoreSpecs(raw)
  };
  const brand = stringField(raw.Brend) || stringField(raw.brand);
  const category = stringField(raw.Kategorija) || stringField(raw.category);
  const gender = stringField(raw.Pol) || stringField(raw.gender);
  const description = stringField(raw.Opis) || stringField(raw.description);
  if (brand) value.brand = brand;
  if (category) value.category = category;
  if (gender) value.gender = gender;
  if (description) value.description = description;
  return { warnings, errors, value };
}

type FirestoreValue = {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
  nullValue?: null;
};

function decodeFirestoreFields(fields: Record<string, FirestoreValue>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, decodeFirestoreValue(value)])
  );
}

function decodeFirestoreValue(value: FirestoreValue): unknown {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('arrayValue' in value) return value.arrayValue?.values?.map(decodeFirestoreValue) ?? [];
  if ('mapValue' in value) return decodeFirestoreFields(value.mapValue?.fields ?? {});
  return null;
}

function collectFirestoreImages(raw: Record<string, unknown>): string[] {
  const candidates = [raw.images, raw.mainImageUrl, raw.thumbnailUrl, raw.image];
  return candidates
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .flatMap((value) => {
      if (typeof value === 'string') {
        return [value];
      }
      if (value && typeof value === 'object') {
        const image = value as Record<string, unknown>;
        return [image.url, image.thumb, image.original, image.thumbnailUrl];
      }
      return [];
    })
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .filter((value, index, list) => list.indexOf(value) === index);
}

function collectFirestoreSpecs(
  raw: Record<string, unknown>
): Record<string, string | number | boolean> {
  const specs: Record<string, string | number | boolean> = {};
  const source = raw.specs;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      const normalizedKey = slugify(key).replace(/-/g, '_');
      if (!normalizedKey) {
        continue;
      }
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        specs[normalizedKey] = value;
      }
    }
  }
  return specs;
}

function isThumbnailUrl(url: string): boolean {
  return /(?:^|[-_/])thumb(?:[-_.]|$)/i.test(url);
}

function findThumbnailForOriginal(
  originalUrl: string,
  imageUrls: string[],
  thumbnails: string[]
): string | null {
  const originalIndex = imageUrls.indexOf(originalUrl);
  const nextThumbnail = imageUrls
    .slice(originalIndex + 1)
    .find((candidate) => isThumbnailUrl(candidate));
  if (nextThumbnail) {
    return nextThumbnail;
  }
  const parsed = splitImageUrl(originalUrl);
  return (
    thumbnails.find((candidate) => {
      const thumb = splitImageUrl(candidate);
      return (
        thumb.directory === parsed.directory &&
        (thumb.basename === `${parsed.basename}-thumb` ||
          thumb.basename.startsWith('thumb_') ||
          thumb.basename.includes(parsed.basename))
      );
    }) ?? null
  );
}

function splitImageUrl(url: string): { directory: string; basename: string } {
  const key = storageKeyFromPublicUrl(url);
  const slashIndex = key.lastIndexOf('/');
  const directory = slashIndex === -1 ? '' : key.slice(0, slashIndex);
  const filename = slashIndex === -1 ? key : key.slice(slashIndex + 1);
  return {
    directory,
    basename: filename.replace(/\.[^.]+$/, '')
  };
}

function storageKeyFromPublicUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
    return path.startsWith('images/') ? path.slice('images/'.length) : path;
  } catch {
    return url.replace(/^\/+/, '').replace(/^images\//, '');
  }
}

function requireReturnedId(result: pg.QueryResult<{ id: string }>, resource: string): string {
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error(`Imported ${resource} upsert did not return an id`);
  }
  return id;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function stringField(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
}
