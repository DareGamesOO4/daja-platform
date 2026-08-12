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
  Req
} from '@nestjs/common';
import type { Request } from 'express';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { z } from 'zod';
import type { AppConfig } from '@daja/config';
import { R2MediaStorageAdapter, StorefrontRepository, type Database } from '@daja/database';
import { requirePermission, ValidationFailedError } from '@daja/security';
import { createRequestId } from '@daja/shared';
import { parseWithSchema, uuidSchema } from '@daja/validation';
import { CustomerAuthService, serializeCustomerPrincipal } from './customer-auth.service.js';
import { CONFIG, DATABASE } from './tokens.js';
import { resolveRequestContext } from './runtime/request-context.js';

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
  email: z.string().email(),
  source: z.string().trim().min(1).max(80).optional()
});

const statusSchema = z.object({
  status: z.string().trim().min(1).max(80)
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
    @Inject(CustomerAuthService) private readonly auth: CustomerAuthService
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

  @Post('phone/start')
  phoneStart() {
    return { supported: false, reason: 'Phone OTP provider is not configured yet' };
  }

  @Post('phone/verify')
  phoneVerify() {
    return { supported: false, reason: 'Phone OTP provider is not configured yet' };
  }

  @Get('oauth/:provider/start')
  oauthStart(@Param('provider') provider: string) {
    return {
      supported: false,
      provider,
      reason: 'OAuth provider credentials are not configured yet'
    };
  }

  @Get('oauth/:provider/callback')
  oauthCallback(@Param('provider') provider: string) {
    return {
      supported: false,
      provider,
      reason: 'OAuth provider credentials are not configured yet'
    };
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
    @Inject(CustomerAuthService) private readonly auth: CustomerAuthService
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
    return new StorefrontRepository(this.database.pool).removeWishlistItem({
      organizationId: customer.organizationId,
      customerId: customer.customerId,
      productId: parseWithSchema(uuidSchema, productId)
    });
  }
}

@Controller()
export class StorefrontOrdersController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CustomerAuthService) private readonly auth: CustomerAuthService
  ) {}

  @Post('orders')
  async createOrder(@Req() request: Request, @Body() body: unknown) {
    const token = bearerToken(request);
    const customer = token
      ? await this.auth.authenticateAccessToken(token).catch(() => null)
      : null;
    const input = parseWithSchema(orderSchema, body);
    return new StorefrontRepository(this.database.pool).createOrder(
      publicOrganizationId(this.config),
      {
        customerId: customer?.customerId ?? null,
        customer: input.customer,
        items: input.items,
        subtotalAmount: amountMinor(input.subtotal),
        discountAmount: amountMinor(input.discountAmount),
        shippingAmount: amountMinor(input.shippingCost),
        totalAmount: amountMinor(input.finalTotal),
        promoCode: input.promoCode ?? null,
        shippingMethod: input.shippingMethod,
        paymentMethod: input.paymentMethod
      }
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
  updateStatus(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'orders.write');
    const input = parseWithSchema(statusSchema, body);
    return new StorefrontRepository(this.database.pool).updateOrderStatus({
      organizationId: ctx.organizationId,
      orderIdOrDisplayId: id,
      status: input.status,
      userId: ctx.userId
    });
  }

  @Patch('admin/orders/:id/read')
  markRead(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'orders.write');
    return new StorefrontRepository(this.database.pool).markOrderRead({
      organizationId: ctx.organizationId,
      orderIdOrDisplayId: id
    });
  }
}

@Controller()
export class StorefrontContentController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CustomerAuthService) private readonly auth: CustomerAuthService
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

  @Post('newsletter/subscribe')
  subscribe(@Body() body: unknown) {
    const input = parseWithSchema(newsletterSchema, body);
    return new StorefrontRepository(this.database.pool).subscribeNewsletter({
      organizationId: publicOrganizationId(this.config),
      ...input
    });
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
    const source = await fetch(input.url, { headers: { Accept: 'image/*' } });
    if (!source.ok) {
      throw new ValidationFailedError('Remote image could not be downloaded');
    }
    const sourceBuffer = Buffer.from(await source.arrayBuffer());
    const base = slugify(input.slug ?? input.productName);
    const image = sharp(sourceBuffer).rotate();
    const original = await image.webp({ quality: 84 }).toBuffer();
    const thumb = await sharp(sourceBuffer)
      .rotate()
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    const key = `${base}/${base}-${createRequestId()}.webp`;
    const thumbKey = key.replace(/\.webp$/, '-thumb.webp');
    const storage = new R2MediaStorageAdapter(this.config);
    const client = createR2Client(this.config);
    await client.send(
      new PutObjectCommand({
        Bucket: storage.bucket(),
        Key: key,
        Body: original,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable'
      })
    );
    await client.send(
      new PutObjectCommand({
        Bucket: storage.bucket(),
        Key: thumbKey,
        Body: thumb,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable'
      })
    );
    const url = storage.publicUrl(key);
    const thumbnailUrl = storage.publicUrl(thumbKey);
    await this.database.pool.query(
      `INSERT INTO media_assets (
         organization_id, storage_provider, storage_bucket, storage_key, public_url,
         mime_type, size_bytes, status, metadata
       )
       VALUES ($1, 'r2', $2, $3, $4, 'image/webp', $5, 'ready', $6::jsonb)`,
      [
        ctx.organizationId,
        storage.bucket(),
        key,
        url,
        original.length,
        JSON.stringify({ sourceUrl: input.url, thumbnailUrl })
      ]
    );
    return {
      url,
      mainImageUrl: url,
      thumbnailUrl,
      storagePath: key,
      results: [{ url, mainImageUrl: url, thumbnailUrl, storagePath: key }]
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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function createR2Client(config: AppConfig): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: config.R2_ENDPOINT || `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: Boolean(config.R2_ENDPOINT),
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY
    }
  });
}
