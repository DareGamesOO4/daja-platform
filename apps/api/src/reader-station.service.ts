import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Database } from '@daja/database';
import { RfidRepository } from '@daja/database';
import type { RequestContext } from '@daja/shared';
import { ResourceConflictError, ValidationFailedError } from '@daja/security';
import { DATABASE } from './tokens.js';
import { RealtimeGateway } from './realtime.gateway.js';

export type ScanStatus = 'awaiting_epc' | 'awaiting_barcode' | 'completed' | 'cancelled' | 'expired';

interface SessionRow {
  id: string; station_id: string; requester_user_id: string; requester_client_id: string; status: ScanStatus;
  epc: string | null; barcode: string | null; product: Record<string, unknown> | null; expires_at: string;
}

@Injectable()
export class ReaderStationService {
  constructor(@Inject(DATABASE) private readonly database: Database, private readonly realtime: RealtimeGateway) {}

  async register(ctx: RequestContext, input: { name: string; locationId?: string | undefined }): Promise<Record<string, unknown>> {
    if (!ctx.deviceId) throw new ValidationFailedError('Reader Station zahteva identitet uređaja.');
    const id = randomUUID();
    const result = await this.database.query<{ id: string; name: string; location_id: string | null }>(
      `INSERT INTO rfid_reader_stations (id, organization_id, device_id, name, location_id, registered_by, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (organization_id, device_id) DO UPDATE SET name=EXCLUDED.name, location_id=EXCLUDED.location_id, registered_by=EXCLUDED.registered_by, last_seen_at=now(), updated_at=now()
       RETURNING id,name,location_id`, [id, ctx.organizationId, ctx.deviceId, input.name, input.locationId ?? null, ctx.userId]
    );
    const row = result.rows[0]!;
    return { id: row.id, name: row.name, locationId: row.location_id, online: true };
  }

  async heartbeat(ctx: RequestContext, stationId: string): Promise<void> {
    if (!ctx.deviceId) throw new ValidationFailedError('Reader Station zahteva identitet uređaja.');
    await this.database.query(`UPDATE rfid_reader_stations SET last_seen_at=now(), updated_at=now() WHERE id=$1 AND organization_id=$2 AND device_id=$3`, [stationId, ctx.organizationId, ctx.deviceId]);
  }

  async list(ctx: RequestContext): Promise<readonly Record<string, unknown>[]> {
    await this.expire();
    const result = await this.database.query<{ id: string; name: string; location_id: string | null; last_seen_at: string }>(
      `SELECT id,name,location_id,last_seen_at FROM rfid_reader_stations WHERE organization_id=$1 AND last_seen_at > now() - interval '45 seconds' ORDER BY last_seen_at DESC`, [ctx.organizationId]
    );
    return result.rows.map((row) => ({ id: row.id, name: row.name, locationId: row.location_id, online: true, lastSeenAt: row.last_seen_at }));
  }

  async start(ctx: RequestContext, input: { stationId: string; clientId: string; preview?: Record<string, unknown> | undefined }): Promise<Record<string, unknown>> {
    await this.expire();
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.stationId]);
      const station = await client.query<{ id: string }>(`SELECT id FROM rfid_reader_stations WHERE id=$1 AND organization_id=$2 AND last_seen_at > now() - interval '45 seconds'`, [input.stationId, ctx.organizationId]);
      if (!station.rows[0]) throw new ValidationFailedError('Izabrani G2 čitač nije online.');
      const active = await client.query(`SELECT 1 FROM rfid_reader_scan_sessions WHERE station_id=$1 AND status IN ('awaiting_epc','awaiting_barcode') AND expires_at > now()`, [input.stationId]);
      if (active.rows[0]) throw new ResourceConflictError('Čitač je zauzet. Sačekajte da se trenutna sesija završi.');
      const id = randomUUID();
      const preview = input.preview ? { found: true, ...input.preview } : null;
      await client.query(`INSERT INTO rfid_reader_scan_sessions (id,organization_id,station_id,requester_user_id,requester_client_id,status,product,expires_at) VALUES ($1,$2,$3,$4,$5,'awaiting_epc',$6::jsonb,now()+interval '30 seconds')`, [id,ctx.organizationId,input.stationId,ctx.userId,input.clientId,JSON.stringify(preview)]);
      await client.query('COMMIT');
      this.realtime.publishToStation(ctx.organizationId, input.stationId, 'reader.scan.start', { sessionId: id, phase: 'epc', product: preview, expiresInSeconds: 30 });
      return { id, stationId: input.stationId, status: 'awaiting_epc', expiresInSeconds: 30 };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async epc(ctx: RequestContext, stationId: string, sessionId: string, rawEpc: string): Promise<Record<string, unknown>> {
    const session = await this.stationSession(ctx, stationId, sessionId, 'awaiting_epc');
    const epc = rawEpc.replace(/[\s:._-]/g, '').toUpperCase();
    if (!epc) throw new ValidationFailedError('EPC nije validan.');
    const resolved = await new RfidRepository(this.database.pool).resolvePublic(ctx, epc) as Record<string, unknown>;
    const product = session.product ?? await this.stationProduct(ctx.organizationId, resolved);
    await this.database.query(`UPDATE rfid_reader_scan_sessions SET status='awaiting_barcode',epc=$2,product=$3::jsonb,expires_at=now()+interval '60 seconds' WHERE id=$1`, [session.id, epc, JSON.stringify(product)]);
    const payload = { sessionId, phase: 'barcode', epc, product, expiresInSeconds: 60 };
    this.realtime.publishToStation(ctx.organizationId, stationId, 'reader.scan.product', payload);
    this.realtime.publishToSession(ctx.organizationId, session.id, 'reader.scan.product', payload);
    return payload;
  }

  async barcode(ctx: RequestContext, stationId: string, sessionId: string, barcode?: string): Promise<Record<string, unknown>> {
    const session = await this.stationSession(ctx, stationId, sessionId, 'awaiting_barcode');
    const normalized = barcode?.trim() || null;
    await this.database.query(`UPDATE rfid_reader_scan_sessions SET status='completed',barcode=$2,completed_at=now() WHERE id=$1`, [session.id, normalized]);
    const payload = { sessionId, status: 'completed', epc: session.epc, barcode: normalized, product: session.product };
    this.realtime.publishToStation(ctx.organizationId, stationId, 'reader.scan.completed', payload);
    this.realtime.publishToSession(ctx.organizationId, session.id, 'reader.scan.completed', payload);
    return payload;
  }

  async cancel(ctx: RequestContext, sessionId: string): Promise<void> {
    const result = await this.database.query<SessionRow>(`UPDATE rfid_reader_scan_sessions SET status='cancelled',completed_at=now() WHERE id=$1 AND organization_id=$2 AND requester_user_id=$3 AND status IN ('awaiting_epc','awaiting_barcode') RETURNING *`, [sessionId,ctx.organizationId,ctx.userId]);
    const row = result.rows[0]; if (!row) return;
    const payload = { sessionId, status: 'cancelled' };
    this.realtime.publishToStation(ctx.organizationId, row.station_id, 'reader.scan.cancelled', payload);
    this.realtime.publishToSession(ctx.organizationId, sessionId, 'reader.scan.cancelled', payload);
  }

  private async stationSession(ctx: RequestContext, stationId: string, sessionId: string, status: ScanStatus): Promise<SessionRow> {
    await this.expire(); await this.heartbeat(ctx, stationId);
    const result = await this.database.query<SessionRow>(`SELECT * FROM rfid_reader_scan_sessions WHERE id=$1 AND station_id=$2 AND organization_id=$3 AND status=$4 AND expires_at>now()`, [sessionId,stationId,ctx.organizationId,status]);
    const row = result.rows[0]; if (!row) throw new ValidationFailedError('Sesija nije aktivna.'); return row;
  }

  private async expire(): Promise<void> {
    await this.database.query(`UPDATE rfid_reader_scan_sessions SET status='expired',completed_at=now() WHERE status IN ('awaiting_epc','awaiting_barcode') AND expires_at<=now()`);
  }

  private async stationProduct(organizationId: string, resolved: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (resolved.found !== true || typeof resolved.productId !== 'string' || typeof resolved.variantId !== 'string') return resolved;
    const details = await this.database.query<Record<string, unknown>>(
      `SELECT p.id AS "productId", v.id AS "variantId", p.name, p.slug, v.sku, v.barcode,
              COALESCE(inventory.quantity,0) AS quantity, location.name AS "locationName", zone.name AS "zoneName", bin.name AS "binName",
              media.public_url AS "imageUrl"
       FROM products p JOIN product_variants v ON v.id=$3 AND v.product_id=p.id AND v.organization_id=p.organization_id
       LEFT JOIN inventory_items inventory ON inventory.variant_id=v.id AND inventory.organization_id=p.organization_id AND inventory.deleted_at IS NULL
       LEFT JOIN locations location ON location.id=inventory.location_id
       LEFT JOIN warehouse_zones zone ON zone.id=inventory.zone_id
       LEFT JOIN warehouse_bins bin ON bin.id=inventory.bin_id
       LEFT JOIN LATERAL (SELECT ma.public_url FROM product_media pm JOIN media_assets ma ON ma.id=pm.media_asset_id AND ma.status='ready' WHERE pm.organization_id=p.organization_id AND pm.product_id=p.id ORDER BY pm.is_primary DESC,pm.position LIMIT 1) media ON true
       WHERE p.organization_id=$1 AND p.id=$2 LIMIT 1`, [organizationId, resolved.productId, resolved.variantId]
    );
    return details.rows[0] ? { ...resolved, ...details.rows[0] } : resolved;
  }
}
