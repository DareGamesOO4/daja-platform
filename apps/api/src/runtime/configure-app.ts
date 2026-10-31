import { performance } from 'node:perf_hooks';
import { json, urlencoded } from 'express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { AbstractHttpAdapter } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { AppConfig } from '@daja/config';
import type { Logger } from '@daja/observability';
import { createRequestId } from '@daja/shared';
import { ApiExceptionFilter } from './api-exception.filter.js';
import { EnvelopeInterceptor } from './envelope.interceptor.js';
import { allowedCorsOrigins } from './cors-policy.js';
import { admissionMiddleware } from './abuse-protection.js';
import { edgeIngress } from './edge-ingress.js';
import { BrowserSessionInterceptor, browserSessionMiddleware } from './browser-session.js';

export function configureApiApp(app: INestApplication, config: AppConfig, logger: Logger): void {
  // Trust only the configured number of proxies, not an arbitrary forwarded
  // chain. Render terminates public requests before they reach Express.
  const adapter = app.getHttpAdapter() as AbstractHttpAdapter;
  adapter.getInstance<{ set(name: string, value: number): void }>().set('trust proxy', config.TRUST_PROXY_HOPS);
  app.use(helmet());
  app.use(edgeIngress(config));
  // Capacitor Android serves the mobile UI from these local origins. Keep
  // them enabled in code so a Render environment update cannot strand the
  // Reader Station with a browser-level "Failed to fetch" error.
  const corsOrigins = allowedCorsOrigins(config.CORS_ALLOWED_ORIGINS, config.NODE_ENV);
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    exposedHeaders: ['Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset']
  });
  // Must precede body parsing and AuthMiddleware (which queries PostgreSQL).
  app.use(admissionMiddleware());
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: false, limit: '1mb' }));
  app.use(browserSessionMiddleware(config));
  app.use((req: Request & { id?: string }, res: Response, next: NextFunction) => {
    // APIs may return customer data, staff records or signed download URLs.
    // Public handlers can explicitly opt into caching when appropriate.
    res.setHeader('Cache-Control', 'no-store');
    if (/^\/api\/v1\/(?:customer-auth(?:\/|$)|privacy\/(?:me|unsubscribe)(?:\/|$)|newsletter(?:\/|$)|products\/[^/]+\/alerts(?:\/|$)|product-alerts\/confirm(?:\/|$)|admin\/emails(?:\/|$)|contact(?:\/|$))/.test(req.path)) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    }
    const startedAt = performance.now();
    const requestId =
      typeof req.headers['x-request-id'] === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(req.headers['x-request-id'])
        ? req.headers['x-request-id']
        : createRequestId();
    req.id = requestId;
    res.setHeader('x-request-id', requestId);
    res.on('finish', () => {
      logger.info(
        {
          requestId,
          // Log the route template, never query strings, raw route parameters
          // or untrusted caller-provided identity fields.
          route: (req.route as { path?: string } | undefined)?.path || '[unmatched]',
          method: req.method,
          statusCode: res.statusCode,
          durationMs: performance.now() - startedAt
        },
        'HTTP request completed'
      );
    });
    next();
  });

  app.setGlobalPrefix('api/v1', { exclude: ['/health/live', '/health/ready'] });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true
    })
  );
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new EnvelopeInterceptor(), app.get(BrowserSessionInterceptor));

  if (config.NODE_ENV !== 'production') {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('DAJA Platform API').setVersion('1.0').build()
    );
    SwaggerModule.setup('/api/v1/docs', app, document);
  }
}
