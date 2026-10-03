import { Body, Controller, Get, Inject, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import type { AppConfig } from '@daja/config';
import { parseWithSchema, uuidSchema } from '@daja/validation';
import { ValidationFailedError } from '@daja/security';
import { CustomerAuthService } from './customer-auth.service.js';
import { EngravingService, engravingDesignSchema } from './engraving.service.js';
import { CONFIG } from './tokens.js';

const png = z.string().max(700000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
const access = z.object({ guestToken: z.string().min(32).max(128).optional() });
@Controller('engraving')
export class EngravingController {
  constructor(@Inject(CONFIG) private readonly config: AppConfig, @Inject(CustomerAuthService) private readonly auth: CustomerAuthService, @Inject(EngravingService) private readonly engraving: EngravingService) {}
  private async identity(request: Request) {
    const authorization = request.headers.authorization;
    const customer = authorization?.startsWith('Bearer ') ? await this.auth.requireCustomer(authorization.slice(7)) : null;
    const organizationId = customer?.organizationId ?? this.config.PUBLIC_ORGANIZATION_ID;
    if (!organizationId) throw new ValidationFailedError('Storefront organization is required.');
    return { organizationId, customerId: customer?.customerId ?? null };
  }
  @Get('drafts')
  async list(@Req() request: Request) {
    const identity = await this.identity(request);
    return identity.customerId ? this.engraving.list(identity.organizationId, identity.customerId) : [];
  }
  @Post('drafts')
  async create(@Req() request: Request, @Body() body: unknown) {
    const input = parseWithSchema(z.object({ productId: uuidSchema, variantId: uuidSchema, design: engravingDesignSchema }), body);
    const identity = await this.identity(request);
    return this.engraving.create(identity.organizationId, identity.customerId, input.productId, input.variantId, input.design);
  }
  @Post('drafts/:id/open')
  async open(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const input = parseWithSchema(access, body); const identity = await this.identity(request);
    return this.engraving.open(identity.organizationId, parseWithSchema(uuidSchema, id), identity.customerId, input.guestToken);
  }
  @Put('drafts/:id')
  async save(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const input = parseWithSchema(access.extend({ version: z.number().int().nonnegative(), design: engravingDesignSchema, preview: png.optional(), artwork: png.optional() }), body);
    const identity = await this.identity(request);
    return this.engraving.save(identity.organizationId, parseWithSchema(uuidSchema, id), identity.customerId, input.guestToken, input.version, input.design, input.preview, input.artwork);
  }
  @Post('drafts/:id/claim')
  async claim(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const input = parseWithSchema(z.object({ guestToken: z.string().min(32).max(128) }), body); const identity = await this.identity(request);
    if (!identity.customerId) throw new ValidationFailedError('Prijavite se da sačuvate nacrt u nalogu.');
    return this.engraving.claim(identity.organizationId, parseWithSchema(uuidSchema, id), identity.customerId, input.guestToken);
  }
  @Post('drafts/:id/assets')
  async upload(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const input = parseWithSchema(access.extend({ dataUrl: png }), body); const identity = await this.identity(request);
    return this.engraving.upload(identity.organizationId, parseWithSchema(uuidSchema, id), identity.customerId, input.guestToken, input.dataUrl);
  }
}
