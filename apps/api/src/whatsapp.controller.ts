import { Body, Controller, Get, Inject, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { AppConfig } from '@daja/config';
import { requirePermission } from '@daja/security';
import { parseWithSchema, uuidSchema } from '@daja/validation';
import { z } from 'zod';
import { CONFIG } from './tokens.js';
import { equalSecret } from './runtime/edge-ingress.js';
import { resolveRequestContext } from './runtime/request-context.js';
import { WhatsAppNotificationsService } from './whatsapp-notifications.service.js';

const subscriptionSchema = z.object({
  phone: z.string().trim().min(8).max(30),
  purpose: z.enum(['newsletter', 'price_change', 'back_in_stock']),
  language: z.enum(['sr','en']).default('sr'),
  productId: uuidSchema.optional(), variantId: uuidSchema.optional(),
  acceptedMarketing: z.literal(true),
  policyVersion: z.string().trim().min(1).max(120).optional(),
  source: z.string().trim().min(1).max(80).optional()
}).refine(v => v.purpose === 'newsletter' ? !v.productId && !v.variantId : Boolean(v.productId && v.variantId));

@Controller()
export class WhatsAppController {
  constructor(@Inject(CONFIG) private readonly config: AppConfig,
    private readonly notifications: WhatsAppNotificationsService) {}

  @Get('whatsapp/capabilities')
  capabilities() { return { available: this.notifications.available() }; }

  @Post('whatsapp/subscriptions/request')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  request(@Body() body: unknown) { return this.notifications.request(parseWithSchema(subscriptionSchema, body)); }

  @Post('whatsapp/subscriptions/status')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  status(@Body() body: unknown) {
    const input = parseWithSchema(z.object({ token: z.string().regex(/^[a-f0-9]{48}$/) }), body);
    return this.notifications.status(input.token);
  }

  @Get('whatsapp/webhook')
  @SkipThrottle()
  verify(@Query() query: Record<string, unknown>, @Res() response: Response) {
    if (this.config.WHATSAPP_WEBHOOK_VERIFY_TOKEN.length < 32 || query['hub.mode'] !== 'subscribe' || !equalSecret(query['hub.verify_token'], this.config.WHATSAPP_WEBHOOK_VERIFY_TOKEN)
      || typeof query['hub.challenge'] !== 'string' || query['hub.challenge'].length > 200) throw new UnauthorizedException();
    response.type('text/plain').status(200).send(query['hub.challenge']);
  }

  @Post('whatsapp/webhook')
  @SkipThrottle()
  async webhook(@Req() request: Request, @Res() response: Response) {
    const raw: unknown = request.body;
    if (!Buffer.isBuffer(raw) || !this.notifications.verifySignature(raw, request.headers['x-hub-signature-256'])) throw new UnauthorizedException();
    await this.notifications.webhook(JSON.parse(raw.toString('utf8')));
    response.status(200).send('EVENT_RECEIVED');
  }

  @Get('admin/whatsapp')
  summary(@Req() request: Request) {
    const ctx = resolveRequestContext(request); requirePermission(ctx, 'promotions.write');
    return this.notifications.summary(ctx.organizationId);
  }

  @Post('admin/whatsapp/campaigns')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  campaign(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request); requirePermission(ctx, 'promotions.write');
    const input = parseWithSchema(z.object({ campaignId: uuidSchema, text: z.string().trim().min(1).max(900), language: z.enum(['sr','en']).default('sr') }), body);
    return this.notifications.campaign(ctx.organizationId, input.campaignId, input.text, input.language);
  }
}
