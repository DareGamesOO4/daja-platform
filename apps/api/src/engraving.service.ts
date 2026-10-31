import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import sharp from 'sharp';
import type { PoolClient } from 'pg';
import type { Database } from '@daja/database';
import { ResourceConflictError, ResourceNotFoundError, ValidationFailedError } from '@daja/security';
import { DATABASE } from './tokens.js';
import { parseWithSchema } from '@daja/validation';

const layerSchema = z.object({
  id: z.string().uuid(), type: z.enum(['text', 'image']), x: z.number().min(0).max(1000), y: z.number().min(0).max(1000),
  rotation: z.number().min(-360).max(360), width: z.number().positive().max(1000), height: z.number().positive().max(1000), locked: z.boolean(),
  text: z.string().max(200).optional(), font: z.enum(['sans', 'serif', 'mono', 'hand']).optional(), fontSize: z.number().min(14).max(100).optional(),
  bold: z.boolean().optional(), italic: z.boolean().optional(), align: z.enum(['left', 'center', 'right']).optional(),
  letterSpacing: z.number().min(-2).max(15).optional(), lineSpacing: z.number().min(1).max(2.5).optional(),
  curve: z.enum(['straight', 'upper', 'lower', 'circle']).optional(), radius: z.number().min(80).max(380).optional(), angle: z.number().min(-180).max(180).optional(),
  arc: z.number().min(30).max(330).optional(), assetId: z.string().uuid().optional(), contrast: z.number().min(0.5).max(3).optional(), threshold: z.number().min(0).max(255).optional(), invert: z.boolean().optional()
}).superRefine((layer, context) => {
  if (layer.type === 'text' && (layer.text === undefined || !layer.font || !layer.fontSize)) context.addIssue({ code: 'custom', message: 'Tekst i font su obavezni.' });
  if (layer.type === 'image' && !layer.assetId) context.addIssue({ code: 'custom', message: 'Slika nije otpremljena.' });
});
export const engravingDesignSchema = z.object({ schemaVersion: z.literal(1), diameter: z.number().min(20).max(70), reserveCenter: z.boolean().optional(), layers: z.array(layerSchema).max(20) });
type Design = z.infer<typeof engravingDesignSchema>;
interface DraftRow {
  id: string;
  organization_id: string;
  customer_id: string | null;
  product_id: string;
  variant_id: string;
  version: number;
  design: unknown;
  preview: string | null;
  artwork: string | null;
}
export interface AssetRow { id: string; dataUrl: string }
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const MAX_DRAFT_BYTES = 4 * 1024 * 1024;
const MAX_ORGANIZATION_BYTES = 64 * 1024 * 1024;
const MAX_ORDER_ENGRAVING_BYTES = 8 * 1024 * 1024;
const STORAGE_LIMIT_MESSAGE = 'Ograničenje prostora za nacrte gravure je dostignuto. Pokušajte kasnije.';

@Injectable()
export class EngravingService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async create(organizationId: string, customerId: string | null, productId: string, variantId: string, design: Design) {
    await this.checkProduct(organizationId, productId, variantId);
    const id = randomUUID(); const guestToken = customerId ? null : randomBytes(32).toString('hex');
    await this.write(organizationId, async (client) => {
      const counts = await client.query<{ total: number; owned: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE customer_id = $2)::int AS owned
         FROM engraving_drafts WHERE organization_id = $1`, [organizationId, customerId]
      );
      if (counts.rows[0]!.total >= 200 || (customerId && counts.rows[0]!.owned >= 20)) {
        throw new ValidationFailedError(STORAGE_LIMIT_MESSAGE);
      }
      await client.query('INSERT INTO engraving_drafts(id, organization_id, customer_id, guest_token_hash, product_id, variant_id, design) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, organizationId, customerId, guestToken ? hash(guestToken) : null, productId, variantId, JSON.stringify(design)]);
      await this.assertStorageQuota(organizationId, id, client);
    });
    return { id, version: 0, guestToken, productId, variantId, design };
  }

  async checkProduct(organizationId: string, productId: string, variantId: string, client: Pick<PoolClient, 'query'> = this.database.pool) {
    const result = await client.query(`SELECT p.id FROM products p JOIN product_variants v ON v.product_id=p.id AND v.organization_id=p.organization_id JOIN departments d ON d.id=p.department_id AND d.organization_id=p.organization_id WHERE p.organization_id=$1 AND p.id=$2 AND v.id=$3 AND p.deleted_at IS NULL AND v.deleted_at IS NULL AND p.active AND p.published AND v.active AND v.published AND d.slug='satovi'`, [organizationId, productId, variantId]);
    if (!result.rowCount) throw new ValidationFailedError('Izabrani sat nije dostupan za graviranje.');
  }

  async owned(organizationId: string, id: string, customerId: string | null, guestToken?: string, client: Pick<PoolClient, 'query'> = this.database.pool) {
    const result = await client.query<DraftRow>(`SELECT * FROM engraving_drafts WHERE id=$1 AND organization_id=$2
      AND ((customer_id IS NOT NULL AND customer_id=$3 AND greatest(created_at, updated_at) > now() - interval '30 days')
        OR (customer_id IS NULL AND guest_token_hash=$4 AND created_at > now() - interval '24 hours'))`, [id, organizationId, customerId, guestToken ? hash(guestToken) : null]);
    if (!result.rows[0]) throw new ResourceNotFoundError('engraving draft');
    return result.rows[0];
  }

  async open(organizationId: string, id: string, customerId: string | null, guestToken?: string) {
    const draft = await this.owned(organizationId, id, customerId, guestToken);
    const assets = await this.database.pool.query<AssetRow>('SELECT id, data_url AS "dataUrl" FROM engraving_assets WHERE draft_id=$1', [id]);
    return { id: draft.id, productId: draft.product_id, variantId: draft.variant_id, version: draft.version, design: draft.design, preview: draft.preview, artwork: draft.artwork, assets: assets.rows };
  }

  async list(organizationId: string, customerId: string) {
    const result = await this.database.pool.query<{ id: string; productId: string; variantId: string; version: number; preview: string | null; updatedAt: Date; slug: string; name: string }>(`SELECT draft.id, draft.product_id AS "productId", draft.variant_id AS "variantId",
      draft.version, draft.preview, draft.updated_at AS "updatedAt", p.slug, p.name
      FROM engraving_drafts draft
      JOIN products p ON p.id=draft.product_id AND p.organization_id=draft.organization_id
      JOIN product_variants v ON v.id=draft.variant_id AND v.product_id=p.id AND v.organization_id=p.organization_id
      WHERE draft.organization_id=$1 AND draft.customer_id=$2
        AND greatest(draft.created_at, draft.updated_at) > now() - interval '30 days'
        AND p.deleted_at IS NULL AND p.active AND p.published
        AND v.deleted_at IS NULL AND v.active AND v.published
      ORDER BY draft.updated_at DESC LIMIT 100`, [organizationId, customerId]);
    return result.rows;
  }

  async save(organizationId: string, id: string, customerId: string | null, guestToken: string | undefined, version: number, design: Design, preview?: string, artwork?: string) {
    await this.owned(organizationId, id, customerId, guestToken);
    const safePreview = preview ? await this.normalizePng(preview) : null;
    const safeArtwork = artwork ? await this.normalizePng(artwork) : null;
    return this.write(organizationId, async (client) => {
      await this.owned(organizationId, id, customerId, guestToken, client);
      await this.validateAssets(id, design, client);
      const result = await client.query<{ version: number }>('UPDATE engraving_drafts SET design=$2, preview=$3, artwork=$5, version=version+1, updated_at=now() WHERE id=$1 AND organization_id=$6 AND version=$4 RETURNING version', [id, JSON.stringify(design), safePreview, version, safeArtwork, organizationId]);
      if (!result.rows[0]) throw new ResourceConflictError('engraving draft version');
      await this.assertStorageQuota(organizationId, id, client);
      return { id, version: result.rows[0].version };
    });
  }

  async claim(organizationId: string, id: string, customerId: string, guestToken: string) {
    await this.write(organizationId, async (client) => {
      const draft = await this.owned(organizationId, id, customerId, guestToken, client);
      if (draft.customer_id) return;
      const count = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM engraving_drafts WHERE organization_id=$1 AND customer_id=$2', [organizationId, customerId]);
      if (count.rows[0]!.count >= 20) throw new ValidationFailedError(STORAGE_LIMIT_MESSAGE);
      await client.query('UPDATE engraving_drafts SET customer_id=$2, guest_token_hash=NULL, updated_at=now() WHERE id=$1 AND organization_id=$3 AND customer_id IS NULL', [id, customerId, organizationId]);
    });
    return this.open(organizationId, id, customerId);
  }

  async upload(organizationId: string, id: string, customerId: string | null, guestToken: string | undefined, dataUrl: string) {
    await this.owned(organizationId, id, customerId, guestToken);
    const safeDataUrl = await this.normalizePng(dataUrl);
    return this.write(organizationId, async (client) => {
      await this.owned(organizationId, id, customerId, guestToken, client);
      const count = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM engraving_assets WHERE draft_id=$1', [id]);
      if (count.rows[0]!.count >= 40) throw new ValidationFailedError('Najviše 40 slika po nacrtu.');
      const assetId = randomUUID();
      await client.query('INSERT INTO engraving_assets(id,draft_id,data_url) VALUES($1,$2,$3)', [assetId, id, safeDataUrl]);
      await client.query('UPDATE engraving_drafts SET updated_at=now() WHERE id=$1 AND organization_id=$2', [id, organizationId]);
      await this.assertStorageQuota(organizationId, id, client);
      return { id: assetId };
    });
  }

  private async normalizePng(dataUrl: string): Promise<string> {
    try {
      if (dataUrl.length > 700000 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw new Error('format');
      const bytes = Buffer.from(dataUrl.split(',')[1] ?? '', 'base64');
      if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
        || bytes.readUInt32BE(16) > 1024 || bytes.readUInt32BE(20) > 1024) throw new Error('dimensions');
      // Decode every pixel and encode a fresh PNG; a valid-looking header alone
      // does not prove that the uploaded file is a safe, complete image.
      const normalized = await sharp(bytes, { limitInputPixels: 1024 * 1024, failOn: 'warning' }).png().toBuffer();
      const result = `data:image/png;base64,${normalized.toString('base64')}`;
      if (result.length > 700000) throw new Error('size');
      return result;
    } catch {
      throw new ValidationFailedError('Slika mora biti PNG do 1024 px.');
    }
  }

  private async write<T>(organizationId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize admission, claims, writes and quota checks across all API instances.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', [`engraving:${organizationId}`]);
      // Submitted artwork is copied into the order snapshot by freezeItems.
      // Cleanup is lazy on writes; quota bounds also hold between requests.
      await client.query(`DELETE FROM engraving_drafts WHERE organization_id=$1 AND
        ((customer_id IS NULL AND created_at <= now() - interval '24 hours')
         OR (customer_id IS NOT NULL AND greatest(created_at, updated_at) <= now() - interval '30 days'))`, [organizationId]);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async assertStorageQuota(organizationId: string, draftId: string, client: PoolClient): Promise<void> {
    const result = await client.query<{ total: string; draft: string }>(
      `WITH sizes AS (
         SELECT d.id, octet_length(d.design::text)::bigint
           + COALESCE(octet_length(d.preview), 0) + COALESCE(octet_length(d.artwork), 0)
           + COALESCE(a.bytes, 0) AS bytes
         FROM engraving_drafts d LEFT JOIN LATERAL (
           SELECT sum(octet_length(data_url)) AS bytes FROM engraving_assets WHERE draft_id=d.id
         ) a ON true WHERE d.organization_id=$1
       ) SELECT COALESCE(sum(bytes),0)::text AS total,
           COALESCE(max(bytes) FILTER (WHERE id=$2),0)::text AS draft FROM sizes`,
      [organizationId, draftId]
    );
    if (Number(result.rows[0]!.total) > MAX_ORGANIZATION_BYTES || Number(result.rows[0]!.draft) > MAX_DRAFT_BYTES) {
      throw new ValidationFailedError(STORAGE_LIMIT_MESSAGE);
    }
  }

  async validateAssets(id: string, design: Design, client: Pick<PoolClient, 'query'> = this.database.pool) {
    const ids = [...new Set(design.layers.filter((layer) => layer.type === 'image').map((layer) => layer.assetId!))];
    if (!ids.length) return [];
    const result = await client.query<AssetRow>('SELECT id,data_url AS "dataUrl" FROM engraving_assets WHERE draft_id=$1 AND id=ANY($2::uuid[])', [id, ids]);
    if (result.rows.length !== ids.length) throw new ValidationFailedError('Slike gravure nisu sačuvane.');
    return result.rows;
  }

  async freezeItems(organizationId: string, customerId: string | null, items: Array<Record<string, unknown>>, client: PoolClient) {
    const frozen = [];
    let frozenBytes = 0;
    for (const item of items) {
      if (!item.engraving) { frozen.push(item); continue; }
      const reference = parseWithSchema(z.object({ draftId: z.string().uuid(), version: z.number().int().nonnegative(), guestToken: z.string().max(128).optional() }), item.engraving);
      const draft = await this.owned(organizationId, reference.draftId, customerId, reference.guestToken, client);
      if (draft.version !== reference.version) throw new ResourceConflictError('engraving draft version');
      if (draft.product_id !== (item.productId || item.id) || draft.variant_id !== item.variantId) throw new ValidationFailedError('Gravura ne pripada izabranom satu.');
      await this.checkProduct(organizationId, draft.product_id, draft.variant_id, client);
      const design = parseWithSchema(engravingDesignSchema, draft.design);
      if (!design.layers.length || !draft.preview || !draft.artwork) throw new ValidationFailedError('Potvrdite kompletan dizajn gravure.');
      for (const layer of design.layers) {
        if (layer.type === 'text' && !layer.text?.trim()) throw new ValidationFailedError('Gravura sadrži prazan tekst.');
        const radius = layer.type === 'text' && layer.curve && layer.curve !== 'straight' ? (layer.radius ?? 260) + (layer.fontSize ?? 44) : Math.hypot(layer.width, layer.height) / 2;
        if (Math.hypot(layer.x - 500, layer.y - 500) + radius > 410) throw new ValidationFailedError('Gravura izlazi van zone graviranja.');
      }
      // Account for every line, including repeated references to the same draft,
      // before loading/copying the images into the persisted order snapshot.
      const assetIds = [...new Set(design.layers.filter((layer) => layer.type === 'image').map((layer) => layer.assetId!))];
      const assetSize = await client.query<{ bytes: string }>(
        'SELECT COALESCE(sum(octet_length(data_url)),0)::text AS bytes FROM engraving_assets WHERE draft_id=$1 AND id=ANY($2::uuid[])',
        [draft.id, assetIds]
      );
      frozenBytes += Number(assetSize.rows[0]!.bytes) + Buffer.byteLength(JSON.stringify(design))
        + Buffer.byteLength(draft.preview) + Buffer.byteLength(draft.artwork) + assetIds.length * 256 + 1024;
      if (frozenBytes > MAX_ORDER_ENGRAVING_BYTES) throw new ValidationFailedError(STORAGE_LIMIT_MESSAGE);
      const assets = await this.validateAssets(draft.id, design, client);
      frozen.push({ ...item, engraving: { draftId: draft.id, version: draft.version, design, preview: draft.preview, artwork: draft.artwork, assets, confirmedAt: new Date().toISOString() } });
    }
    return frozen;
  }
}
