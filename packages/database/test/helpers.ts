import type pg from 'pg';
import { loadConfig } from '@daja/config';
import { createLogger } from '@daja/observability';
import { createDatabase, type Database } from '../src/pool.js';

export function testEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
  process.env.PORT = process.env.PORT ?? '3000';
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ??
    'postgres://daja_app:daja_app_password@localhost:5432/daja_platform';
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
  process.env.API_PUBLIC_BASE_URL = process.env.API_PUBLIC_BASE_URL ?? 'http://localhost:3000';
  process.env.CORS_ALLOWED_ORIGINS = process.env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:3000';
  process.env.JWT_ACCESS_SECRET =
    process.env.JWT_ACCESS_SECRET ?? 'test-access-secret-with-at-least-32-chars';
  process.env.JWT_REFRESH_SECRET =
    process.env.JWT_REFRESH_SECRET ?? 'test-refresh-secret-with-at-least-32-chars';
  process.env.TRUSTED_IDENTITY_HEADERS = process.env.TRUSTED_IDENTITY_HEADERS ?? 'true';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
}

export function createTestDatabase(): Database {
  testEnv();
  const config = loadConfig();
  return createDatabase(config, createLogger(config, 'test'));
}

export async function resetDatabase(pool: pg.Pool): Promise<void> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Refusing to reset database outside NODE_ENV=test');
  }
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public AUTHORIZATION daja_app');
  await pool.query('GRANT ALL ON SCHEMA public TO public');
  await pool.query('GRANT ALL ON SCHEMA public TO daja_app');
}

export function contextFor(organizationId: string) {
  return {
    requestId: '00000000-0000-4000-8000-000000000001',
    correlationId: '00000000-0000-4000-8000-000000000002',
    organizationId,
    userId: '00000000-0000-4000-8000-000000000003',
    roles: ['owner'],
    permissions: ['admin.users']
  };
}

export async function createFixtureUser(pool: pg.Pool, organizationId: string): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, organization_id, email, display_name)
     VALUES ($1, $2, $3, $4)`,
    [
      '00000000-0000-4000-8000-000000000003',
      organizationId,
      `fixture-${organizationId}@example.test`,
      'Fixture User'
    ]
  );
}
