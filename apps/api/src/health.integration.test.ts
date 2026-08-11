import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Response } from 'supertest';
import { Test } from '@nestjs/testing';
import { loadConfig } from '@daja/config';
import { createLogger } from '@daja/observability';
import { AppModule } from './app.module.js';
import { configureApiApp } from './runtime/configure-app.js';
import { createTestDatabase, resetDatabase } from '../../../packages/database/test/helpers.js';
import { migrate } from '@daja/database';
import type { INestApplication } from '@nestjs/common';
import type { Database } from '@daja/database';

describe('health endpoints', () => {
  let app: INestApplication;
  let database: Database;

  beforeAll(async () => {
    database = createTestDatabase();
    await resetDatabase(database.pool);
    await migrate(database.pool);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    const config = loadConfig();
    configureApiApp(app, config, createLogger(config, 'api-test'));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  it('serves live and ready health checks', async () => {
    const server = app.getHttpServer() as Parameters<typeof request>[0];
    const liveResponse: Response = await request(server).get('/health/live').expect(200);
    const liveBody = liveResponse.body as { requestId: string };
    expect(liveBody.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(liveResponse.headers['x-request-id']).toBe(liveBody.requestId);

    const response: Response = await request(server).get('/health/ready').expect(200);
    const body = response.body as { data: { checks: { postgres: string; redis: string } } };
    expect(body.data.checks).toEqual({ postgres: 'ok', redis: 'ok' });
  });
});
