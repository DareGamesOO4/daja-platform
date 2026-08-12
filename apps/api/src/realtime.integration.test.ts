import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@daja/config';
import { createDatabase, createRedisConnection, migrate, type Database } from '@daja/database';
import { createLogger } from '@daja/observability';
import { AppModule } from './app.module.js';
import { configureApiApp } from './runtime/configure-app.js';
import { DATABASE, REDIS } from './tokens.js';

describe('realtime gateway', () => {
  let app: INestApplication;
  let database: Database;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.PORT = '3000';
    process.env.DATABASE_URL =
      process.env.DATABASE_URL ??
      'postgres://daja_app:daja_app_password@localhost:5432/daja_platform';
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
    process.env.API_PUBLIC_BASE_URL = 'http://localhost:3000';
    process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000';
    process.env.LOG_LEVEL = 'silent';
    const config = loadConfig();
    const logger = createLogger(config, 'realtime-test');
    database = createDatabase(config, logger);
    await migrate(database.pool);
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(DATABASE)
      .useValue(database)
      .overrideProvider(REDIS)
      .useValue(createRedisConnection(config, logger))
      .compile();
    app = moduleRef.createNestApplication();
    configureApiApp(app, config, logger);
    await app.listen(0);
  });

  afterEach(async () => {
    for (const socket of sockets) {
      socket.disconnect();
    }
    await app.get<{ close(): Promise<void> }>(REDIS).close();
    await app.close();
    await database.close();
  });

  it('requires realtime identity and accepts tenant-scoped subscriptions', async () => {
    const server = app.getHttpServer() as { address(): { port: number } };
    const address = server.address();
    const baseUrl = `http://localhost:${address.port}/realtime`;
    const rejected = io(baseUrl, { transports: ['websocket'], reconnection: false, timeout: 1000 });
    sockets.push(rejected);
    await expect(waitForDisconnect(rejected)).resolves.toBe(true);

    const accepted = io(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      auth: {
        organizationId: '00000000-0000-4000-8000-000000000801',
        userId: '00000000-0000-4000-8000-000000000802',
        permissions: 'realtime.read'
      }
    });
    sockets.push(accepted);
    await waitForConnect(accepted);
    const response = await emitWithAck(accepted, 'subscribe', {});
    expect(response).toEqual({ ok: true });
  });
});

function waitForConnect(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
}

function waitForDisconnect(socket: Socket): Promise<boolean> {
  return new Promise((resolve) => {
    socket.once('disconnect', () => resolve(true));
  });
}

function emitWithAck(socket: Socket, event: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    socket.timeout(1000).emit(event, payload, (_error: Error | null, response: unknown) => {
      resolve(response);
    });
  });
}
