/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { createRequestId } from '@daja/shared';

type RealtimeEvent =
  | 'product.updated'
  | 'price.changed'
  | 'media.ready'
  | 'inventory.changed'
  | 'rfid.tag.assigned'
  | 'rfid.tag.status_changed'
  | 'reader.status'
  | 'sync.conflict';

const allowedEvents: RealtimeEvent[] = [
  'product.updated',
  'price.changed',
  'media.ready',
  'inventory.changed',
  'rfid.tag.assigned',
  'rfid.tag.status_changed',
  'reader.status',
  'sync.conflict'
];

@WebSocketGateway({
  namespace: '/realtime',
  cors: { origin: false }
})
export class RealtimeGateway {
  @WebSocketServer()
  private readonly server!: Server;

  handleConnection(socket: Socket): void {
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
      socket.emit('error', {
        code: 'REALTIME_AUTH_REQUIRED',
        message: 'Realtime authentication requires organization, user and realtime.read permission',
        requestId: createRequestId()
      });
      socket.disconnect(true);
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

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function splitCsv(value: string | undefined): string[] {
  return value
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}
