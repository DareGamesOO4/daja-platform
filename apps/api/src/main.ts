import 'reflect-metadata';
import { performance } from 'node:perf_hooks';
import { json, urlencoded } from 'express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { loadConfig } from '@daja/config';
import { createLogger } from '@daja/observability';
import { AppModule } from './app.module.js';
import { ApiExceptionFilter } from './runtime/api-exception.filter.js';
import { EnvelopeInterceptor } from './runtime/envelope.interceptor.js';

const config = loadConfig();
const logger = createLogger(config, 'api-bootstrap');

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled rejection');
  process.exitCode = 1;
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  process.exit(1);
});

const app = await NestFactory.create(AppModule, { bufferLogs: true });

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
    typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : undefined;
  if (requestId) {
    req.id = requestId;
  }
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

await app.listen(config.PORT);
logger.info({ port: config.PORT }, 'DAJA API listening');
