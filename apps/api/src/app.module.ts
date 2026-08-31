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
import { OfflineInventoryController } from './offline-inventory.controller.js';
import { DevicePluginsController } from './device-plugins.controller.js';
import { DevicePluginsService } from './device-plugins.service.js';
import { CustomerAuthService } from './customer-auth.service.js';
import { DesktopGoogleOAuthService } from './desktop-google-oauth.service.js';
import { NewsletterEmailService } from './newsletter-email.service.js';
import { EmailDeliveryService } from './email-delivery.service.js';
import { OrderEmailService } from './order-email.service.js';
import {
  CustomerAuthController,
  CustomerController,
  StorefrontContentController,
  StorefrontMediaController,
  StorefrontOrdersController
} from './storefront.controller.js';

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
    CustomerAuthController,
    CustomerController,
    StorefrontOrdersController,
    StorefrontContentController,
    StorefrontMediaController,
    HealthController,
    OrganizationsController,
    PublicCatalogController,
    StaffCatalogController,
    MediaController,
    RfidController,
    InventoryController,
    ImportsController,
    DeviceController,
    SyncController,
    OfflineInventoryController,
    DevicePluginsController
  ],
  providers: [
    { provide: CONFIG, useValue: config },
    { provide: LOGGER, useValue: logger },
    { provide: DATABASE, useFactory: () => createDatabase(config, logger) },
    { provide: REDIS, useFactory: () => createRedisConnection(config, logger) },
    AuthMiddleware,
    AuthService,
    CustomerAuthService,
    DesktopGoogleOAuthService,
    EmailDeliveryService,
    NewsletterEmailService,
    OrderEmailService,
    RealtimeGateway,
    DevicePluginsService
  ]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMiddleware).forRoutes('*');
  }
}
