import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { loadConfig } from '@daja/config';
import { createDatabase, createRedisConnection } from '@daja/database';
import { createLogger } from '@daja/observability';
import { CONFIG, DATABASE, LOGGER, REDIS } from './tokens.js';
import { HealthController } from './health.controller.js';
import { OrganizationsController } from './organizations.controller.js';

const config = loadConfig();
const logger = createLogger(config, 'api');

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 120
      }
    ])
  ],
  controllers: [HealthController, OrganizationsController],
  providers: [
    { provide: CONFIG, useValue: config },
    { provide: LOGGER, useValue: logger },
    { provide: DATABASE, useFactory: () => createDatabase(config, logger) },
    { provide: REDIS, useFactory: () => createRedisConnection(config, logger) }
  ]
})
export class AppModule {}
