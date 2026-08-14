import { config as loadEnvironment } from 'dotenv';
import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from '@daja/config';
import { createLogger } from '@daja/observability';

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

await app.listen(config.PORT);
logger.info({ port: config.PORT }, 'DAJA API listening');
