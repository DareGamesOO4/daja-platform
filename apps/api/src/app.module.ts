import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { loadConfig } from '@daja/config';
import { createDatabase, createRedisConnection } from '@daja/database';
import { createLogger } from '@daja/observability';
import { CONFIG, DATABASE, LOGGER, REDIS } from './tokens.js';
import { HealthController } from './health.controller.js';
import { OrganizationsController } from './organizations.controller.js';
import {
  ImportsController,
  InventoryController,
  MediaController,
  PublicCatalogController,
  RfidController,
  StaffCatalogController
} from './plan2.controllers.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { DeviceController, SyncController } from './sync.controller.js';
import { AuthController } from './auth.controller.js';
import { AuthMiddleware } from './auth.middleware.js';
import { AuthService } from './auth.service.js';

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
  controllers: [
    AuthController,
    HealthController,
    OrganizationsController,
    PublicCatalogController,
    StaffCatalogController,
    MediaController,
    RfidController,
    InventoryController,
    ImportsController,
    DeviceController,
    SyncController
  ],
  providers: [
    { provide: CONFIG, useValue: config },
    { provide: LOGGER, useValue: logger },
    { provide: DATABASE, useFactory: () => createDatabase(config, logger) },
    { provide: REDIS, useFactory: () => createRedisConnection(config, logger) },
    AuthMiddleware,
    AuthService,
    RealtimeGateway
  ]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMiddleware).forRoutes('*');
  }
}
