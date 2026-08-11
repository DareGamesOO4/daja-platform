import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Response } from 'supertest';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module.js';
import { ApiExceptionFilter } from './runtime/api-exception.filter.js';
import { EnvelopeInterceptor } from './runtime/envelope.interceptor.js';
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
    app.useGlobalFilters(new ApiExceptionFilter());
    app.useGlobalInterceptors(new EnvelopeInterceptor());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  it('serves live and ready health checks', async () => {
    const server = app.getHttpServer() as Parameters<typeof request>[0];
    await request(server).get('/health/live').expect(200);
    const response: Response = await request(server).get('/health/ready').expect(200);
    const body = response.body as { data: { checks: { postgres: string; redis: string } } };
    expect(body.data.checks).toEqual({ postgres: 'ok', redis: 'ok' });
  });
});
