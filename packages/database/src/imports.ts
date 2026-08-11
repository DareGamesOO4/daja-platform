/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import type pg from 'pg';
import ExcelJS from 'exceljs';
import { ValidationFailedError } from '@daja/security';
import type { RequestContext } from '@daja/shared';
import { CatalogRepository } from './catalog.js';

export interface NormalizedImportRow {
  sourceId: string;
  name: string;
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
       WHERE organization_id = $1 AND import_job_id = $2 AND status = 'valid'
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
    const catalog = new CatalogRepository(this.client);
    let imported = 0;
    for (const row of rows.rows as Array<{ id: string; normalized_payload: NormalizedImportRow }>) {
      const payload = row.normalized_payload;
      const product = await catalog.createProduct(ctx, {
        name: payload.name,
        slug: slugify(`${payload.sourceId}-${payload.name}`),
        description: payload.description ?? null,
        externalId: payload.sourceId,
        published: false
      });
      const variant = await catalog.createVariant(ctx, product.id, {
        sku: payload.sourceId,
        currentPriceAmount: payload.priceMinor,
        currency: 'RSD',
        gender: payload.gender ?? null,
        attributes: payload.specs,
        published: false
      });
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

  async reconciliation(ctx: Pick<RequestContext, 'organizationId'>, jobId: string) {
    const result = await this.client.query(
      `SELECT
         COUNT(*)::integer AS "sourceProductCount",
         COUNT(*) FILTER (WHERE status = 'imported')::integer AS "productsImported",
         COUNT(*) FILTER (WHERE status = 'skipped')::integer AS "productsSkipped",
         COUNT(*) FILTER (WHERE jsonb_array_length(errors) > 0)::integer AS "failedRows",
         jsonb_agg(DISTINCT raw_payload->>'Slika') FILTER (WHERE raw_payload ? 'Slika') AS "imageUrlDomains"
       FROM import_rows
       WHERE organization_id = $1 AND import_job_id = $2`,
      [ctx.organizationId, jobId]
    );
    return result.rows[0];
  }

  async createFirestoreJob(
    ctx: RequestContext,
    input: { sourceName: string; dryRun: boolean; checkpoint?: Record<string, unknown> | undefined }
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
          note: 'Firestore tool is read-only; execution requires service-account credentials supplied at runtime.'
        })
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Firestore import job insert did not return an id');
    }
    return { jobId: row.id, dryRun: input.dryRun };
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
