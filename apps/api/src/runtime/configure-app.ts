import { performance } from 'node:perf_hooks';
import { json, urlencoded } from 'express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { AppConfig } from '@daja/config';
import type { Logger } from '@daja/observability';
import { createRequestId } from '@daja/shared';
import { ApiExceptionFilter } from './api-exception.filter.js';
import { EnvelopeInterceptor } from './envelope.interceptor.js';

export function configureApiApp(app: INestApplication, config: AppConfig, logger: Logger): void {
  app.use(helmet());
  app.enableCors({
    origin: config.CORS_ALLOWED_ORIGINS,
    credentials: true
  });
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: false, limit: '1mb' }));
  app.use((req: Request & { id?: string }, res: Response, next: NextFunction) => {
    const startedAt = performance.now();
    const requestId =
      typeof req.headers['x-request-id'] === 'string'
        ? req.headers['x-request-id']
        : createRequestId();
    req.id = requestId;
    res.setHeader('x-request-id', requestId);
    res.on('finish', () => {
      logger.info(
        {
          requestId,
          correlationId: req.headers['x-correlation-id'],
          organizationId: req.headers['x-organization-id'],
          userId: req.headers['x-user-id'],
          route: req.originalUrl,
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
  app.useGlobalInterceptors(new EnvelopeInterceptor());

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('DAJA Platform API').setVersion('1.0').build()
  );
  SwaggerModule.setup('/api/v1/docs', app, document);
}
