import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import type { RequestWithAuthContext } from './auth.controller.js';
import { loadConfig } from '@daja/config';
import { createDatabase, createRedisConnection } from '@daja/database';
import { createLogger } from '@daja/observability';
import { CONFIG, DATABASE, LOGGER, REDIS } from './tokens.js';
import { HealthController } from './health.controller.js';
import { CatalogFiltersController } from './catalog-filters.controller.js';
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
import { ReaderStationController } from './reader-station.controller.js';
import { ReaderStationService } from './reader-station.service.js';
import { DeviceController, SyncController } from './sync.controller.js';
import { InternalSalesReportController } from './internal-sales-report.controller.js';
import { AuthController } from './auth.controller.js';
import { AuthMiddleware } from './auth.middleware.js';
import { EngravingController } from './engraving.controller.js';
import { EngravingService } from './engraving.service.js';
import { AuthService } from './auth.service.js';
import { AccessControlController } from './access-control.controller.js';
import { OfflineInventoryController } from './offline-inventory.controller.js';
import { DevicePluginsController } from './device-plugins.controller.js';
import { DevicePluginsService } from './device-plugins.service.js';
import { CustomerAuthService } from './customer-auth.service.js';
import { PhoneOtpService } from './phone-otp.service.js';
import { SmsDeliveryService } from './sms-delivery.service.js';
import { DesktopGoogleOAuthService } from './desktop-google-oauth.service.js';
import { NovostiEmailService } from './novosti-email.service.js';
import { EmailDeliveryService } from './email-delivery.service.js';
import { OrderEmailService } from './order-email.service.js';
import { ProductAlertService } from './product-alert.service.js';
import { PrivacyService } from './privacy.service.js';
import { PrivacyController } from './privacy.controller.js';
import { PolicyPublicationService } from './policy-publication.service.js';
import { PromotionsService } from './promotions.service.js';
import { PromotionsAdminController } from './promotions.controller.js';
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
    ThrottlerModule.forRoot({
      // HTTP limits must not run against the WebSocket gateway or health probes.
      skipIf: context => context.getType() !== 'http' || context.getClass() === HealthController,
      getTracker: request => {
        const ctx = (request as RequestWithAuthContext).authContext;
        // AuthMiddleware verifies this identity. Never trust device/user headers
        // directly, or rotating a header would bypass the limiter.
        return ctx ? `staff:${ctx.organizationId}:${ctx.userId}:${ctx.deviceId || 'web'}` : `ip:${request.ip}`;
      },
      throttlers: [{
        ttl: 60_000,
        // Staff devices make bursts during inventory/sync; explicit @Throttle
        // limits still override this default on sensitive handlers.
        limit: context => context.switchToHttp().getRequest<RequestWithAuthContext>().authContext ? 600 : 120
      }]
    })
  ],
  controllers: [
    EngravingController,
    CatalogFiltersController,
    AuthController,
    AccessControlController,
    CustomerAuthController,
    CustomerController,
    StorefrontOrdersController,
    StorefrontContentController,
    StorefrontMediaController,
    PromotionsAdminController,
    PrivacyController,
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
    InternalSalesReportController,
    OfflineInventoryController,
    DevicePluginsController
    ,ReaderStationController
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    EngravingService,
    { provide: CONFIG, useValue: config },
    { provide: LOGGER, useValue: logger },
    { provide: DATABASE, useFactory: () => createDatabase(config, logger) },
    { provide: REDIS, useFactory: () => createRedisConnection(config, logger) },
    AuthMiddleware,
    AuthService,
    CustomerAuthService,
    PhoneOtpService,
    SmsDeliveryService,
    DesktopGoogleOAuthService,
    EmailDeliveryService,
    NovostiEmailService,
    OrderEmailService,
    ProductAlertService,
    PrivacyService,
    PolicyPublicationService,
    PromotionsService,
    RealtimeGateway,
    ReaderStationService,
    DevicePluginsService
  ]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMiddleware).forRoutes('{*path}');
  }
}
