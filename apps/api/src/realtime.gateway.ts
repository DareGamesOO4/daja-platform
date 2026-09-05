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
import { AuthService } from './auth.service.js';
import { CustomerAuthService } from './customer-auth.service.js';
import { CONFIG } from './tokens.js';

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
  // The storefront and API are deployed on different Render origins.  Socket.IO
  // polling therefore needs an explicit cross-origin response, while the
  // gateway still authenticates every non-public room below.
  cors: { origin: true, credentials: true }
})
export class RealtimeGateway {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(CustomerAuthService) private readonly customerAuth: CustomerAuthService,
    @Inject(CONFIG) private readonly config: AppConfig
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
        if (!ctx.permissions.includes('realtime.read')) {
          deny(socket);
          return;
        }
        socket.data.organizationId = ctx.organizationId;
        socket.data.userId = ctx.userId;
        socket.data.permissions = ctx.permissions;
        socket.data.locationId = ctx.locationId;
        void socket.join(orgRoom(ctx.organizationId));
        if (ctx.locationId) {
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

  publishCustomerEmailVerified(input: { organizationId: string; customerId: string }): void {
    this.server.to(customerRoom(input.organizationId, input.customerId)).emit('customer.email_verified', {
      event: 'customer.email_verified',
      data: { emailVerified: true },
      serverTime: new Date().toISOString()
    });
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
