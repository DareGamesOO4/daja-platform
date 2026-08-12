/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access */
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@daja/config';
import { createDatabase, createRedisConnection, migrate, type Database } from '@daja/database';
import { createLogger } from '@daja/observability';
import { resetDatabase } from '../../../packages/database/test/helpers.js';
import { AppModule } from './app.module.js';
import { AuthService } from './auth.service.js';
import { configureApiApp } from './runtime/configure-app.js';
import { DATABASE, REDIS } from './tokens.js';

describe('staff authentication', () => {
  let app: INestApplication;
  let database: Database;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.PORT = '3000';
    process.env.DATABASE_URL =
      process.env.DATABASE_URL ??
      'postgres://daja_app:daja_app_password@localhost:5432/daja_platform';
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
    process.env.API_PUBLIC_BASE_URL = 'http://localhost:3000';
    process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000';
    process.env.JWT_ACCESS_SECRET = 'test-access-secret-with-at-least-32-chars';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-with-at-least-32-chars';
    process.env.TRUSTED_IDENTITY_HEADERS = 'false';
    process.env.LOG_LEVEL = 'silent';
    const config = loadConfig();
    const logger = createLogger(config, 'auth-test');
    database = createDatabase(config, logger);
    await resetDatabase(database.pool);
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
    await app.init();
    await seedStaffUser(app, database);
  });

  afterEach(async () => {
    await app.get<{ close(): Promise<void> }>(REDIS).close();
    await app.close();
    await database.close();
  });

  it('logs in, resolves me from Bearer token, rotates refresh tokens, and rejects reuse', async () => {
    const server = app.getHttpServer();
    const login = await request(server)
      .post('/api/v1/auth/login')
      .send({
        organizationId: '00000000-0000-4000-8000-000000000901',
        email: 'staff@daja.test',
        password: 'correct-password',
        deviceId: '00000000-0000-4000-8000-000000000903'
      })
      .expect(201);
    expect(login.body.data.accessToken).toEqual(expect.any(String));
    expect(login.body.data.refreshToken).toEqual(expect.any(String));

    await request(server)
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${login.body.data.accessToken}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.data.permissions).toContain('realtime.read');
        expect(response.body.data.permissions).toContain('sync.view');
      });

    await request(server)
      .get('/api/v1/auth/me')
      .set('x-organization-id', '00000000-0000-4000-8000-000000000901')
      .set('x-user-id', '00000000-0000-4000-8000-000000000902')
      .expect(401);

    const refresh = await request(server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: login.body.data.refreshToken })
      .expect(201);
    expect(refresh.body.data.refreshToken).not.toEqual(login.body.data.refreshToken);

    await request(server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: login.body.data.refreshToken })
      .expect(401);
  });
});

async function seedStaffUser(app: INestApplication, database: Database): Promise<void> {
  const passwordHash = await app.get(AuthService).hashPassword('correct-password');
  await database.pool.query(
    `INSERT INTO organizations (id, name, slug, status)
     VALUES ('00000000-0000-4000-8000-000000000901', 'DAJA', 'daja', 'active')`
  );
  await database.pool.query(
    `INSERT INTO users (id, organization_id, email, display_name, password_hash, active)
     VALUES ('00000000-0000-4000-8000-000000000902', '00000000-0000-4000-8000-000000000901',
             'staff@daja.test', 'Staff User', $1, true)`,
    [passwordHash]
  );
  await database.pool.query(
    `INSERT INTO roles (id, organization_id, name, description, system_role)
     VALUES ('00000000-0000-4000-8000-000000000904', '00000000-0000-4000-8000-000000000901',
             'owner', 'Owner', true)`
  );
  await database.pool.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT '00000000-0000-4000-8000-000000000904', id
     FROM permissions
     WHERE id IN ('realtime.read', 'sync.view', 'sync.create', 'sync.update', 'admin.users')`
  );
  await database.pool.query(
    `INSERT INTO user_roles (user_id, role_id)
     VALUES ('00000000-0000-4000-8000-000000000902', '00000000-0000-4000-8000-000000000904')`
  );
}
