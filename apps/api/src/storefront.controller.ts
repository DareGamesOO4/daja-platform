import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AppConfig } from '@daja/config';
import { StorefrontRepository, type Database } from '@daja/database';
import { requirePermission, ValidationFailedError } from '@daja/security';
import { parseWithSchema, uuidSchema } from '@daja/validation';
import { CustomerAuthService, serializeCustomerPrincipal } from './customer-auth.service.js';
import { AuthService } from './auth.service.js';
import { DesktopGoogleOAuthService } from './desktop-google-oauth.service.js';
import { NewsletterEmailService } from './newsletter-email.service.js';
import { OrderEmailService } from './order-email.service.js';
import { ProductAlertService } from './product-alert.service.js';
import { PrivacyService } from './privacy.service.js';
import { CONFIG, DATABASE } from './tokens.js';
import { resolveRequestContext } from './runtime/request-context.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { importRemoteImage } from './remote-media.service.js';

const registerSchema = z.object({
  identity: z.string().trim().min(3).max(240),
  password: z.string().min(6).max(240),
  name: z.string().trim().min(1).max(240)
});

const loginSchema = z.object({
  identity: z.string().trim().min(3).max(240),
  password: z.string().min(1).max(240)
});

const refreshSchema = z.object({ refreshToken: z.string().min(1) });
const passwordUpdateSchema = z.object({
  currentPassword: z.string().min(1).max(240).optional(),
  newPassword: z.string().min(8).max(240)
});
const emailVerificationTokenSchema = z.string().trim().min(32).max(256);
const adminSessionSchema = z.object({ deviceId: z.string().uuid() });

const addressSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  icon: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(240),
  phone: z.string().trim().min(1).max(80),
  address: z.string().trim().min(1).max(500),
  city: z.string().trim().min(1).max(160),
  zip: z.string().trim().max(40).nullable().optional(),
  countryCode: z.string().trim().length(2).optional(),
  isDefault: z.boolean().optional()
});

const cartSchema = z.object({
  items: z.array(z.record(z.string(), z.unknown())).max(200)
});

const wishlistSchema = z.object({
  item: z.record(z.string(), z.unknown())
});

const orderSchema = z.object({
  customer: z.record(z.string(), z.unknown()),
  items: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
  subtotal: z.coerce.number().min(0),
  discountAmount: z.coerce.number().min(0).default(0),
  shippingCost: z.coerce.number().min(0).default(0),
  finalTotal: z.coerce.number().min(0),
  promoCode: z.string().trim().min(1).max(80).nullable().optional(),
  shippingMethod: z.enum(['courier', 'pickup']),
  paymentMethod: z.enum(['cod', 'pickup']).default('cod')
});

const reviewSchema = z.object({
  userName: z.string().trim().min(1).max(160).optional(),
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().min(1).max(5000)
});

const newsletterSchema = z.object({
  email: z.string().email().optional(),
  managementToken: z.string().trim().min(24).max(160).optional(),
  source: z.string().trim().min(1).max(80).optional(),
  acceptedMarketing: z.literal(true),
  policyVersion: z.string().trim().min(1).max(120).optional()
}).refine((value) => Boolean(value.email || value.managementToken), {
  message: 'Unesite email adresu ili koristite sačuvani kontakt.',
  path: ['email']
});

const productAlertSchema = z.object({
  type: z.enum(['back_in_stock', 'price_change']),
  variantId: uuidSchema,
  email: z.string().trim().email().max(240).optional(),
  managementToken: z.string().trim().min(24).max(160).optional(),
  acceptedTerms: z.literal(true),
  policyVersion: z.string().trim().min(1).max(120).optional()
});
const productAlertStatusQuerySchema = z.object({
  variantId: uuidSchema,
  managementToken: z.string().trim().min(24).max(160).optional()
});
const productAlertUnsubscribeSchema = z.object({
  type: z.enum(['back_in_stock', 'price_change']),
  variantId: uuidSchema,
  managementToken: z.string().trim().min(24).max(160).optional()
});

const statusSchema = z.object({
  status: z.string().trim().min(1).max(80)
});

const promotionSchema = z.object({
  code: z.string().trim().min(1).max(80),
  subtotal: z.coerce.number().min(0)
});

const remoteImageSchema = z.object({
  url: z.string().url(),
  productName: z.string().trim().min(1).max(240),
  slug: z.string().trim().min(1).max(240).optional()
});

@Controller('customer-auth')
export class CustomerAuthController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CustomerAuthService) private readonly auth: CustomerAuthService,
    @Inject(AuthService) private readonly staffAuth: AuthService,
    @Inject(DesktopGoogleOAuthService) private readonly desktopGoogle: DesktopGoogleOAuthService,
    private readonly realtime: RealtimeGateway
  ) {}

  @Post('register')
  register(@Body() body: unknown) {
    const input = parseWithSchema(registerSchema, body);
    return this.auth.register({ organizationId: publicOrganizationId(this.config), ...input });
  }

  @Post('login')
  login(@Body() body: unknown) {
    const input = parseWithSchema(loginSchema, body);
    return this.auth.login({ organizationId: publicOrganizationId(this.config), ...input });
  }

  @Post('refresh')
  refresh(@Body() body: unknown) {
    return this.auth.refresh(parseWithSchema(refreshSchema, body));
  }

  @Post('logout')
  async logout(@Req() request: Request) {
    await this.auth.logout(bearerToken(request));
    return { ok: true };
  }

  @Get('me')
  async me(@Req() request: Request) {
    return {
      user: serializeCustomerPrincipal(await this.auth.requireCustomer(bearerToken(request)))
    };
  }

  @Post('password')
  async setPassword(@Req() request: Request, @Body() body: unknown) {
    const customer = await this.auth.requireCustomer(bearerToken(request));
    const input = parseWithSchema(passwordUpdateSchema, body);
    return {
      user: serializeCustomerPrincipal(
        await this.auth.setPassword({ customer, ...input })
      )
    };
  }

  @Post('email/verification')
  async requestEmailVerification(@Req() request: Request) {
    const customer = await this.auth.requireCustomer(bearerToken(request));
    return this.auth.requestEmailVerification({
      organizationId: customer.organizationId,
      customerId: customer.customerId
    });
  }

  @Get('email/verify')
  async confirmEmailVerification(@Query('token') token: unknown) {
    const confirmed = await this.auth.confirmEmailVerification(
      parseWithSchema(emailVerificationTokenSchema, token)
    );
    this.realtime.publishCustomerEmailVerified({
      organizationId: confirmed.organizationId,
      customerId: confirmed.customerId
    });
    return { status: 'verified', email: confirmed.email };
  }

  @Post('admin/session')
  async adminSession(@Req() request: Request, @Body() body: unknown) {
    const customer = await this.auth.requireCustomer(bearerToken(request));
    const input = parseWithSchema(adminSessionSchema, body);
    const result = await this.staffAuth.loginConfiguredStorefrontAdmin({
      customer,
      deviceId: input.deviceId,
      requestId: request.headers['x-request-id'] as string | undefined,
      correlationId: request.headers['x-correlation-id'] as string | undefined
    });
    return {
      ...result.tokens,
      user: {
        userId: result.principal.userId,
        email: result.principal.email,
        roles: result.principal.roles,
        permissions: result.principal.permissions
      }
    };
  }

  @Post('phone/start')
  phoneStart() {
    return { supported: false, reason: 'Phone OTP provider is not configured yet' };
  }

  @Post('phone/verify')
  phoneVerify() {
    return { supported: false, reason: 'Phone OTP provider is not configured yet' };
  }

  @Get('oauth/google/start')
  googleOauthStart(
    @Query('returnTo') returnTo: string | undefined,
    @Res() response: Response
  ) {
    const organizationId = publicOrganizationId(this.config);
    const url = this.auth.startGoogleOAuth(organizationId, returnTo);
    response.redirect(url);
  }

  @Get('oauth/google/callback')
  async googleOauthCallback(
    @Res() response: Response,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined
  ) {
    if (await this.desktopGoogle.isDesktopGoogleCallback(state)) {
      response.redirect(
        await this.desktopGoogle.complete({
          state: state!,
          ...(code === undefined ? {} : { code }),
          ...(error === undefined ? {} : { error })
        })
      );
      return;
    }
    if (error || !code || !state) {
      response.redirect(this.auth.oauthErrorRedirect(state));
      return;
    }
    try {
      const tokens = await this.auth.loginWithGoogle({
        organizationId: publicOrganizationId(this.config),
        code,
        state
      });
      response.redirect(this.auth.oauthSuccessRedirect(tokens, state));
    } catch {
      response.redirect(this.auth.oauthErrorRedirect(state));
    }
  }

  @Post('passkeys/register-challenge')
  passkeyRegisterChallenge() {
    return { supported: false, reason: 'Passkey attestation is not configured yet' };
  }

  @Post('passkeys/register-verify')
  passkeyRegisterVerify() {
    return { supported: false, reason: 'Passkey attestation is not configured yet' };
  }

  @Post('passkeys/login-challenge')
  passkeyLoginChallenge() {
    return { supported: false, reason: 'Passkey assertion is not configured yet' };
  }

  @Post('passkeys/login-verify')
  passkeyLoginVerify() {
    return { supported: false, reason: 'Passkey assertion is not configured yet' };
  }
}

@Controller('customers/me')
export class CustomerController {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CustomerAuthService) private readonly auth: CustomerAuthService,
    private readonly privacy: PrivacyService
  ) {}

  @Get()
  async getMe(@Req() request: Request) {
    const customer = await this.auth.requireCustomer(bearerToken(request));
    return new StorefrontRepository(this.database.pool).getCustomer({
      organizationId: customer.organizationId,
      customerId: customer.customerId
    });
  }

  @Patch()
  async patchMe(@Req() request: Request, @Body() body: unknown) {
    const customer = await this.auth.requireCustomer(bearerToken(request));
    const input = parseWithSchema(
      z.object({
        displayName: z.string().trim().min(1).max(240).optional(),
        phone: z.string().trim().min(1).max(80).nullable().optional(),
        photoUrl: z.string().url().nullable().optional()
      }),
      body
    );
    return new StorefrontRepository(this.database.pool).updateCustomer({
      organizationId: customer.organizationId,
      customerId: customer.customerId,
      ...input
    });
  }

  @Get('addresses')
  async listAddresses(@Req() request: Request) {
    const customer = await this.auth.requireCustomer(bearerToken(request));
    return new StorefrontRepository(this.database.pool).listAddresses({
      organizationId: customer.organizationId,
      customerId: customer.customerId
    });
  }

  @Post('addresses')
  async createAddress(@Req() request: Request, @Body() body: unknown) {
    const customer = await this.auth.requireCustomer(bearerToken(request));
    return new StorefrontRepository(this.database.pool).createAddress({
      organizationId: customer.organizationId,
      customerId: customer.customerId,
      payload: parseWithSchema(addressSchema, body)
    });
  }

  @Patch('addresses/:id')
  async updateAddress(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const customer = await this.auth.requireCustomer(bearerToken(request));
    return new StorefrontRepository(this.database.pool).updateAddress({
      organizationId: customer.organizationId,
      customerId: customer.customerId,
      addressId: parseWithSchema(uuidSchema, id),
      payload: parseWithSchema(addressSchema.partial(), body)
    });
  }

  @Delete('addresses/:id')
  async deleteAddress(@Req() request: Request, @Param('id') id: string) {
    const customer = await this.auth.requireCustomer(bearerToken(request));
    await new StorefrontRepository(this.database.pool).deleteAddress({
      organizationId: customer.organizationId,
      customerId: customer.customerId,
      addressId: parseWithSchema(uuidSchema, id)
    });
    return { deleted: true };
  }

  @Get('cart')
  async getCart(@Req() request: Request) {
    const customer = await this.auth.requireCustomer(bearerToken(request));
    return new StorefrontRepository(this.database.pool).getCart({
      organizationId: customer.organizationId,
      customerId: customer.customerId
    });
  }

  @Put('cart')
  async putCart(@Req() request: Request, @Body() body: unknown) {
    const customer = await this.auth.requireCustomer(bearerToken(request));
    const input = parseWithSchema(cartSchema, body);
    return new StorefrontRepository(this.database.pool).replaceCart({
      organizationId: customer.organizationId,
      customerId: customer.customerId,
      items: input.items
    });
  }

  @Get('wishlist')
  async getWishlist(@Req() request: Request) {
    const customer = await this.auth.requireCustomer(bearerToken(request));
    return new StorefrontRepository(this.database.pool).listWishlist({
      organizationId: customer.organizationId,
      customerId: customer.customerId
    });
  }

  @Post('wishlist')
  async addWishlist(@Req() request: Request, @Body() body: unknown) {
    const customer = await this.auth.requireCustomer(bearerToken(request));
    const input = parseWithSchema(wishlistSchema, body);
    return new StorefrontRepository(this.database.pool).addWishlistItem({
      organizationId: customer.organizationId,
      customerId: customer.customerId,
      item: input.item
    });
  }

  @Delete('wishlist/:productId')
  async removeWishlist(@Req() request: Request, @Param('productId') productId: string) {
    const customer = await this.auth.requireCustomer(bearerToken(request));
    const result = await new StorefrontRepository(this.database.pool).removeWishlistItem({
      organizationId: customer.organizationId,
      customerId: customer.customerId,
      email: customer.email,
      productId: parseWithSchema(uuidSchema, productId)
    });
    await Promise.all(
      result.alertIds.map((subscriptionId) =>
        this.privacy.revokeProductAlertSubscription({
          organizationId: customer.organizationId,
          subscriptionId,
          customerId: customer.customerId,
          customerEmail: customer.email,
          source: 'wishlist_removed'
        })
      )
    );
    return result.wishlist;
  }
}

@Controller()
export class StorefrontOrdersController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CustomerAuthService) private readonly auth: CustomerAuthService,
    private readonly orderEmail: OrderEmailService,
    private readonly realtime: RealtimeGateway
  ) {}

  @Post('orders')
  async createOrder(@Req() request: Request, @Body() body: unknown) {
    const token = bearerToken(request);
    const customer = token
      ? await this.auth.authenticateAccessToken(token).catch(() => null)
      : null;
    const input = parseWithSchema(orderSchema, body);
    const promotion = await this.resolveNewsletterPromotion(
      publicOrganizationId(this.config),
      customer,
      input.promoCode,
      input.subtotal
    );
    const order = await new StorefrontRepository(this.database.pool).createOrder(
      publicOrganizationId(this.config),
      {
        customerId: customer?.customerId ?? null,
        customer: input.customer,
        items: input.items,
        subtotalAmount: amountMinor(input.subtotal),
        discountAmount: amountMinor(promotion.discountAmount),
        shippingAmount: amountMinor(input.shippingCost),
        totalAmount: amountMinor(
          Math.max(0, input.subtotal - promotion.discountAmount + input.shippingCost)
        ),
        promoCode: promotion.code,
        shippingMethod: input.shippingMethod,
        paymentMethod: input.paymentMethod
      }
    );
    this.realtime.publish({
      organizationId: publicOrganizationId(this.config),
      event: 'orders.created',
      payload: { orderId: order.id, displayId: order.displayId }
    });
    await this.orderEmail.sendOrderCreated(order);
    return order;
  }

  @Post('promotions/validate')
  async validatePromotion(@Req() request: Request, @Body() body: unknown) {
    const customer = await this.auth.requireCustomer(bearerToken(request));
    const input = parseWithSchema(promotionSchema, body);
    return this.resolveNewsletterPromotion(
      customer.organizationId,
      customer,
      input.code,
      input.subtotal
    );
  }

  @Get('orders/me')
  async myOrders(@Req() request: Request) {
    const customer = await this.auth.requireCustomer(bearerToken(request));
    return new StorefrontRepository(this.database.pool).listCustomerOrders({
      organizationId: customer.organizationId,
      customerId: customer.customerId,
      email: customer.email
    });
  }

  @Get('orders/:id')
  async getOrder(@Req() request: Request, @Param('id') id: string) {
    const customer = await this.auth.requireCustomer(bearerToken(request));
    const order = await new StorefrontRepository(this.database.pool).getOrder({
      organizationId: customer.organizationId,
      orderIdOrDisplayId: id
    });
    if (order.customer?.email && customer.email && order.customer.email !== customer.email) {
      throw new ValidationFailedError('Order does not belong to customer');
    }
    return order;
  }

  @Get('admin/orders')
  adminOrders(@Req() request: Request) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'orders.read');
    return new StorefrontRepository(this.database.pool).listAdminOrders(ctx.organizationId);
  }

  @Patch('admin/orders/:id/status')
  async updateStatus(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'orders.write');
    const input = parseWithSchema(statusSchema, body);
    const order = await new StorefrontRepository(this.database.pool).updateOrderStatus({
      organizationId: ctx.organizationId,
      orderIdOrDisplayId: id,
      status: input.status,
      userId: ctx.userId
    });
    this.realtime.publish({
      organizationId: ctx.organizationId,
      event: 'orders.updated',
      payload: { orderId: order.id, status: order.status }
    });
    await this.orderEmail.sendStatusUpdate(order);
    return order;
  }

  @Patch('admin/orders/:id/read')
  async markRead(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'orders.write');
    const order = await new StorefrontRepository(this.database.pool).markOrderRead({
      organizationId: ctx.organizationId,
      orderIdOrDisplayId: id
    });
    this.realtime.publish({
      organizationId: ctx.organizationId,
      event: 'orders.updated',
      payload: { orderId: order.id, isRead: true }
    });
    return order;
  }

  private async resolveNewsletterPromotion(
    organizationId: string,
    customer: { customerId: string; email: string | null } | null,
    rawCode: string | null | undefined,
    subtotal: number
  ): Promise<{ code: string | null; discountAmount: number }> {
    if (!rawCode) return { code: null, discountAmount: 0 };
    if (rawCode.trim().toUpperCase() !== 'DOBRODOSLI10') {
      throw new ValidationFailedError('Promo code is not valid');
    }
    if (!customer?.email)
      throw new ValidationFailedError(
        'Login with a verified email is required for this promo code'
      );
    const subscribed = await this.database.pool.query(
      `SELECT 1 FROM newsletter_subscribers WHERE organization_id = $1 AND normalized_email = lower($2) AND active LIMIT 1`,
      [organizationId, customer.email]
    );
    if (!subscribed.rowCount)
      throw new ValidationFailedError('Newsletter subscription is required for this promo code');
    const previous = await this.database.pool.query(
      `SELECT 1 FROM orders WHERE organization_id = $1 AND deleted_at IS NULL
       AND (customer_id = $2 OR lower(customer_email) = lower($3)) LIMIT 1`,
      [organizationId, customer.customerId, customer.email]
    );
    if (previous.rowCount)
      throw new ValidationFailedError('This promo code is valid only for the first order');
    return { code: 'DOBRODOSLI10', discountAmount: Math.round(subtotal * 0.1 * 100) / 100 };
  }
}

@Controller()
export class StorefrontContentController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CustomerAuthService) private readonly auth: CustomerAuthService,
    @Inject(NewsletterEmailService) private readonly newsletterEmail: NewsletterEmailService,
    private readonly productAlerts: ProductAlertService,
    private readonly privacy: PrivacyService
  ) {}

  @Get('products/:productId/reviews')
  listReviews(@Param('productId') productId: string) {
    return new StorefrontRepository(this.database.pool).listReviews(
      publicOrganizationId(this.config),
      parseWithSchema(uuidSchema, productId)
    );
  }

  @Post('products/:productId/reviews')
  async addReview(
    @Req() request: Request,
    @Param('productId') productId: string,
    @Body() body: unknown
  ) {
    const token = bearerToken(request);
    const customer = token
      ? await this.auth.authenticateAccessToken(token).catch(() => null)
      : null;
    const input = parseWithSchema(reviewSchema, body);
    return new StorefrontRepository(this.database.pool).addReview({
      organizationId: customer?.organizationId ?? publicOrganizationId(this.config),
      productId: parseWithSchema(uuidSchema, productId),
      customerId: customer?.customerId ?? null,
      userName: input.userName ?? customer?.displayName ?? 'Kupac',
      rating: input.rating,
      comment: input.comment
    });
  }

  @Post('products/:productId/alerts')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async subscribeProductAlert(
    @Req() request: Request,
  @Param('productId') productId: string,
    @Body() body: unknown
  ) {
    const token = bearerToken(request);
    const customer = token ? await this.auth.authenticateAccessToken(token).catch(() => null) : null;
    const input = parseWithSchema(productAlertSchema, body);
    const email = customer?.email ?? input.email;
    return this.productAlerts.subscribe({
      organizationId: publicOrganizationId(this.config),
      productId: parseWithSchema(uuidSchema, productId),
      variantId: input.variantId,
      ...(customer?.customerId ? { customerId: customer.customerId } : {}),
      email,
      managementToken: input.managementToken,
      acceptedTerms: input.acceptedTerms,
      policyVersion: input.policyVersion,
      type: input.type
    });
  }

  @Delete('products/:productId/alerts')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async unsubscribeProductAlert(
    @Req() request: Request,
    @Param('productId') productId: string,
    @Body() body: unknown
  ) {
    const token = bearerToken(request);
    const customer = token ? await this.auth.authenticateAccessToken(token).catch(() => null) : null;
    const input = parseWithSchema(productAlertUnsubscribeSchema, body);
    const unsubscribed = await this.productAlerts.unsubscribe({
      organizationId: publicOrganizationId(this.config),
      productId: parseWithSchema(uuidSchema, productId),
      variantId: input.variantId,
      ...(customer?.customerId ? { customerId: customer.customerId } : {}),
      email: customer?.email,
      managementToken: input.managementToken,
      type: input.type
    });
    return { ok: true, unsubscribed };
  }

  @Post('products/:productId/alerts/status')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async productAlertStatus(
    @Req() request: Request,
    @Param('productId') productId: string,
    @Body() body: unknown
  ) {
    const input = parseWithSchema(productAlertStatusQuerySchema, body);
    const token = bearerToken(request);
    const customer = token ? await this.auth.authenticateAccessToken(token).catch(() => null) : null;
    return this.productAlerts.activeTypes({
      organizationId: publicOrganizationId(this.config),
      productId: parseWithSchema(uuidSchema, productId),
      variantId: input.variantId,
      ...(customer?.customerId ? { customerId: customer.customerId } : {}),
      email: customer?.email,
      managementToken: input.managementToken
    });
  }

  @Post('newsletter/subscribe')
  async subscribe(@Req() request: Request, @Body() body: unknown) {
    const input = parseWithSchema(newsletterSchema, body);
    const organizationId = publicOrganizationId(this.config);
    const token = bearerToken(request);
    const customer = token ? await this.auth.authenticateAccessToken(token).catch(() => null) : null;
    const alertContact = input.managementToken
      ? await this.privacy.alertContactByToken(organizationId, input.managementToken)
      : null;
    const email = input.email ?? alertContact?.email ?? customer?.email;
    if (!email) throw new ValidationFailedError('Email adresa nije dostupna.');
    const subscriber = await this.privacy.subscribeNewsletter({
      organizationId,
      email,
      source: input.source ?? 'site',
      policyVersion: input.policyVersion,
      ...(customer?.email?.toLowerCase() === email.toLowerCase()
        ? { customerId: customer.customerId }
        : {})
    });
    if (!subscriber.alreadySubscribed) {
      await this.newsletterEmail.sendWelcomeEmail({
        recipient: subscriber.email,
        unsubscribeUrl: subscriber.unsubscribeUrl
      });
    }
    return subscriber;
  }
}

@Controller('media')
export class StorefrontMediaController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database
  ) {}

  @Post('remote-image')
  async remoteImage(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'media.upload');
    const input = parseWithSchema(remoteImageSchema, body);
    const imported = await importRemoteImage({
      config: this.config,
      database: this.database,
      organizationId: ctx.organizationId,
      sourceUrl: input.url
    });
    return {
      success: true,
      ...imported,
      url: imported.publicUrl,
      storagePath: imported.storageKey,
      results: [
        {
          mediaId: imported.mediaId,
          url: imported.publicUrl,
          mainImageUrl: imported.mainImageUrl,
          thumbnailUrl: imported.thumbnailUrl,
          storagePath: imported.storageKey
        }
      ]
    };
  }
}

function publicOrganizationId(config: AppConfig): string {
  if (!config.PUBLIC_ORGANIZATION_ID) {
    throw new ValidationFailedError('PUBLIC_ORGANIZATION_ID is required for storefront routes');
  }
  return config.PUBLIC_ORGANIZATION_ID;
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.authorization;
  return authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : undefined;
}

function amountMinor(value: number): number {
  return Math.max(0, Math.round(value * 100));
}
