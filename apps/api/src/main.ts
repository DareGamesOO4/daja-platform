import { config as loadEnvironment } from 'dotenv';
import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from '@daja/config';
import { type Database } from '@daja/database';
import { createLogger } from '@daja/observability';
import { DATABASE } from './tokens.js';
import { startSupplierChecks } from './supplier-checks.js';

loadEnvironment({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const config = loadConfig();
const logger = createLogger(config, 'api-bootstrap');
const { AppModule } = await import('./app.module.js');
const { configureApiApp } = await import('./runtime/configure-app.js');

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled rejection');
  process.exitCode = 1;
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  process.exit(1);
});

const app = await NestFactory.create(AppModule, { bufferLogs: true });
configureApiApp(app, config, logger);
const server = app.getHttpServer() as Server;
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 60;

await app.listen(config.PORT);
startSupplierChecks(app.get<Database>(DATABASE), logger);
logger.info({ port: config.PORT }, 'DAJA API listening');
