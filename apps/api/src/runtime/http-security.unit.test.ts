import 'reflect-metadata';
import {
  Controller,
  Get,
  Req,
  ServiceUnavailableException,
  type INestApplication
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@daja/config';
import { createLogger } from '@daja/observability';
import { configureApiApp } from './configure-app.js';
import { resolveRequestContext } from './request-context.js';

@Controller('security-probe')
class SecurityProbeController {
  @Get('private')
  privateData(@Req() req: Request) {
    return resolveRequestContext(req);
  }

  @Get('error')
  error() {
    throw new ServiceUnavailableException('postgres://fake:fake-password@internal/database');
  }
}

describe('production HTTP security configuration without external services', () => {
  let app: INestApplication;
  let server: Server;
  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TRUSTED_IDENTITY_HEADERS', 'true');
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://dajashop.rs',
      LOG_LEVEL: 'silent'
    });
    const module = await Test.createTestingModule({
      controllers: [SecurityProbeController]
    }).compile();
    app = module.createNestApplication();
    configureApiApp(app, config, createLogger(config, 'http-security-test'));
    await app.init();
    server = app.getHttpServer() as Server;
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('rejects forged staff identity and prevents caching of private responses', async () => {
    const result = await request(server)
      .get('/api/v1/security-probe/private')
      .set('x-user-id', 'attacker')
      .set('x-organization-id', 'tenant')
      .set('x-permissions', '*')
      .expect(401);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['x-content-type-options']).toBe('nosniff');
  });
  it('hides diagnostics and does not publish Swagger in production', async () => {
    const result = await request(server).get('/api/v1/security-probe/error').expect(503);
    expect(JSON.stringify(result.body)).not.toContain('fake-password');
    expect(JSON.stringify(result.body)).not.toContain('postgres:');
    await request(server).get('/api/v1/docs').expect(404);
  });
  it('allows the storefront origin and does not reflect arbitrary browser origins', async () => {
    const allowed = await request(server)
      .options('/api/v1/security-probe/private')
      .set('Origin', 'https://dajashop.rs');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://dajashop.rs');
    const blocked = await request(server)
      .options('/api/v1/security-probe/private')
      .set('Origin', 'https://attacker.example');
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });
});
