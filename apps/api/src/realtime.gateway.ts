/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { Inject } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { createRequestId } from '@daja/shared';
import type { AppConfig } from '@daja/config';
import type { Database } from '@daja/database';
import { AuthService } from './auth.service.js';
import { CustomerAuthService } from './customer-auth.service.js';
import { CONFIG, DATABASE } from './tokens.js';

type RealtimeEvent =
  | 'product.updated'
  | 'catalog.taxonomy.updated'
  | 'price.changed'
  | 'media.ready'
  | 'inventory.changed'
  | 'rfid.tag.assigned'
  | 'rfid.tag.status_changed'
  | 'reader.status'
  | 'sync.conflict'
  | 'orders.created'
  | 'orders.updated'
  | 'customer.email_verified';

const allowedEvents: RealtimeEvent[] = [
  'product.updated',
  'catalog.taxonomy.updated',
  'price.changed',
  'media.ready',
  'inventory.changed',
  'rfid.tag.assigned',
  'rfid.tag.status_changed',
  'reader.status',
  'sync.conflict',
  'orders.created',
  'orders.updated',
  'customer.email_verified'
];

@WebSocketGateway({
  namespace: '/realtime',
  // Socket.IO has its own CORS layer, separate from Express. Reflect the
  // Android Capacitor origin here; connection authorization still requires a
  // valid access token in handleConnection.
  cors: { origin: true, credentials: true }
})
export class RealtimeGateway {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(CustomerAuthService) private readonly customerAuth: CustomerAuthService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database
  ) {}

  @WebSocketServer()
  private readonly server!: Server;

  async handleConnection(socket: Socket): Promise<void> {
    const token = bearerToken(socket);
    if (token) {
      try {
        const ctx = await this.authService.authenticateAccessToken(token, {
          locationId:
            stringValue(socket.handshake.auth.locationId) ??
            stringValue(socket.handshake.query.locationId)
        });
        const catalogContributor = ctx.roles.includes('Unosilac kataloga');
        if (!ctx.permissions.includes('realtime.read') && !catalogContributor) {
          deny(socket);
          return;
        }
        socket.data.organizationId = ctx.organizationId;
        socket.data.userId = ctx.userId;
        socket.data.permissions = ctx.permissions;
        socket.data.locationId = ctx.locationId;
        socket.data.deviceId = ctx.deviceId;
        // Contributors only need their own reader scan room. Do not put them
        // in the organization-wide room, which contains unrelated staff
        // events such as orders and inventory updates.
        if (ctx.permissions.includes('realtime.read')) void socket.join(orgRoom(ctx.organizationId));
        if (ctx.locationId && ctx.permissions.includes('realtime.read')) {
          void socket.join(locationRoom(ctx.organizationId, ctx.locationId));
        }
        return;
      } catch {
        try {
          const customer = await this.customerAuth.authenticateAccessToken(token);
          socket.data.organizationId = customer.organizationId;
          socket.data.customerId = customer.customerId;
          socket.data.customer = true;
          void socket.join(customerRoom(customer.organizationId, customer.customerId));
          return;
        } catch {
          deny(socket);
          return;
        }
      }
    }

    // The storefront catalog is public, so visitors without an account may
    // subscribe only to its safe product-change channel. They are deliberately
    // put in a separate room and can never receive staff/order events.
    if (socket.handshake.auth.publicCatalog === true && this.config.PUBLIC_ORGANIZATION_ID) {
      socket.data.publicCatalog = true;
      void socket.join(publicCatalogRoom(this.config.PUBLIC_ORGANIZATION_ID));
      return;
    }

    if (process.env.TRUSTED_IDENTITY_HEADERS !== 'true') {
      deny(socket);
      return;
    }

    const organizationId =
      stringValue(socket.handshake.auth.organizationId) ??
      stringValue(socket.handshake.query.organizationId);
    const userId =
      stringValue(socket.handshake.auth.userId) ?? stringValue(socket.handshake.query.userId);
    const permissions = splitCsv(
      stringValue(socket.handshake.auth.permissions) ??
        stringValue(socket.handshake.query.permissions)
    );
    const locationId =
      stringValue(socket.handshake.auth.locationId) ??
      stringValue(socket.handshake.query.locationId);
    if (!organizationId || !userId || !permissions.includes('realtime.read')) {
      deny(socket);
      return;
    }
    socket.data.organizationId = organizationId;
    socket.data.userId = userId;
    socket.data.permissions = permissions;
    socket.data.locationId = locationId;
    socket.data.deviceId = stringValue(socket.handshake.auth.deviceId) ?? stringValue(socket.handshake.query.deviceId);
    void socket.join(orgRoom(organizationId));
    if (locationId) {
      void socket.join(locationRoom(organizationId, locationId));
    }
  }

  @SubscribeMessage('subscribe')
  subscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { locationId?: string | undefined } | undefined
  ) {
    if (!socket.data.organizationId) {
      socket.disconnect(true);
      return { ok: false };
    }
    if (body?.locationId && body.locationId === socket.data.locationId) {
      void socket.join(locationRoom(socket.data.organizationId, body.locationId));
    }
    return { ok: true };
  }

  publish(input: {
    organizationId: string;
    locationId?: string | null | undefined;
    event: RealtimeEvent;
    payload: Record<string, unknown>;
  }): void {
    if (!allowedEvents.includes(input.event)) {
      return;
    }
    const envelope = {
      event: input.event,
      data: sanitizePayload(input.event, input.payload),
      serverTime: new Date().toISOString()
    };
    const target = input.locationId
      ? this.server.to(locationRoom(input.organizationId, input.locationId))
      : this.server.to(orgRoom(input.organizationId));
    target.emit(input.event, envelope);
    if (input.event === 'product.updated' && !input.locationId) {
      this.server.to(publicCatalogRoom(input.organizationId)).emit(input.event, envelope);
    }
  }

  /** A scan room is a random, per-browser-session capability. It prevents
   * unrelated admin tabs from receiving another tab's reader result. */
  @SubscribeMessage('reader.scan.subscribe')
  async subscribeScan(@ConnectedSocket() socket: Socket, @MessageBody() body: { sessionId?: string } | undefined) {
    if (!socket.data.organizationId || !body?.sessionId || !/^[0-9a-f-]{36}$/i.test(body.sessionId)) return { ok: false };
    const allowed = await this.database.query(`SELECT 1 FROM rfid_reader_scan_sessions WHERE id=$1 AND organization_id=$2 AND requester_user_id=$3`, [body.sessionId, socket.data.organizationId, socket.data.userId]);
    if (!allowed.rows[0]) return { ok: false };
    void socket.join(scanRoom(socket.data.organizationId, body.sessionId));
    return { ok: true };
  }

  @SubscribeMessage('reader.find.subscribe')
  async subscribeFind(@ConnectedSocket() socket: Socket, @MessageBody() body: { sessionId?: string } | undefined) {
    if (!socket.data.organizationId || !body?.sessionId || !/^[0-9a-f-]{36}$/i.test(body.sessionId)) return { ok: false };
    const allowed = await this.database.query(`SELECT 1 FROM rfid_reader_find_sessions WHERE id=$1 AND organization_id=$2 AND requester_user_id=$3`, [body.sessionId, socket.data.organizationId, socket.data.userId]);
    if (!allowed.rows[0]) return { ok: false };
    void socket.join(scanRoom(socket.data.organizationId, body.sessionId));
    return { ok: true };
  }

  @SubscribeMessage('reader.station.subscribe')
  async subscribeStation(@ConnectedSocket() socket: Socket, @MessageBody() body: { stationId?: string } | undefined) {
    if (!socket.data.organizationId || !body?.stationId || !/^[0-9a-f-]{36}$/i.test(body.stationId)) return { ok: false };
    const allowed = await this.database.query(`SELECT 1 FROM rfid_reader_stations WHERE id=$1 AND organization_id=$2 AND device_id=$3`, [body.stationId, socket.data.organizationId, socket.data.deviceId]);
    if (!allowed.rows[0]) return { ok: false };
    void socket.join(stationRoom(socket.data.organizationId, body.stationId));
    return { ok: true };
  }

  publishCustomerEmailVerified(input: { organizationId: string; customerId: string }): void {
    this.server.to(customerRoom(input.organizationId, input.customerId)).emit('customer.email_verified', {
      event: 'customer.email_verified',
      data: { emailVerified: true },
      serverTime: new Date().toISOString()
    });
  }

  publishToStation(organizationId: string, stationId: string, event: string, data: Record<string, unknown>): void {
    this.server.to(stationRoom(organizationId, stationId)).emit(event, { event, data, serverTime: new Date().toISOString() });
  }

  publishToSession(organizationId: string, sessionId: string, event: string, data: Record<string, unknown>): void {
    this.server.to(scanRoom(organizationId, sessionId)).emit(event, { event, data, serverTime: new Date().toISOString() });
  }
}

function sanitizePayload(event: RealtimeEvent, payload: Record<string, unknown>) {
  if (event.startsWith('rfid.')) {
    const safe = { ...payload };
    delete safe.tid;
    delete safe.locationHistory;
    delete safe.audit;
    return safe;
  }
  return payload;
}

function orgRoom(organizationId: string): string {
  return `org:${organizationId}`;
}

function locationRoom(organizationId: string, locationId: string): string {
  return `org:${organizationId}:location:${locationId}`;
}

function publicCatalogRoom(organizationId: string): string {
  return `public-catalog:${organizationId}`;
}

function customerRoom(organizationId: string, customerId: string): string {
  return `customer:${organizationId}:${customerId}`;
}
function stationRoom(organizationId: string, stationId: string): string { return `reader-station:${organizationId}:${stationId}`; }
function scanRoom(organizationId: string, sessionId: string): string { return `reader-scan:${organizationId}:${sessionId}`; }

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function bearerToken(socket: Socket): string | undefined {
  const authorization =
    stringValue(socket.handshake.auth.token) ??
    stringValue(socket.handshake.query.token) ??
    stringValue(socket.handshake.headers.authorization);
  if (!authorization) {
    return undefined;
  }
  return authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : authorization;
}

function deny(socket: Socket): void {
  socket.emit('error', {
    code: 'REALTIME_AUTH_REQUIRED',
    message: 'Realtime authentication requires a valid token with realtime.read permission',
    requestId: createRequestId()
  });
  socket.disconnect(true);
}

function splitCsv(value: string | undefined): string[] {
  return value
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}
