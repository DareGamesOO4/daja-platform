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
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
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
