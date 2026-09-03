import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { requirePermission } from '@daja/security';
import { parseWithSchema, uuidSchema } from '@daja/validation';
import { resolveRequestContext } from './runtime/request-context.js';
import { PromotionsService } from './promotions.service.js';

const idListSchema = z.array(uuidSchema).max(500).default([]);
const specificationRuleSchema = z.object({
  specKeyId: uuidSchema,
  specKeySlug: z.string().trim().min(1).max(120).optional(),
  specKeyName: z.string().trim().min(1).max(240).optional(),
  value: z.string().trim().min(1).max(240),
  operator: z.enum(['equals', 'contains']).default('equals')
});
const emptyScopeDefault = {
  productIds: [],
  variantIds: [],
  categoryIds: [],
  brandIds: [],
  departmentIds: [],
  specifications: []
};
const scopeSchema = z.object({
  productIds: idListSchema,
  variantIds: idListSchema,
  categoryIds: idListSchema,
  brandIds: idListSchema,
  departmentIds: idListSchema,
  specifications: z.array(specificationRuleSchema).max(50).default([])
});
const promotionInputSchema = z.object({
  code: z.string().trim().min(3).max(40),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2_000).nullable().optional(),
  internalNote: z.string().trim().max(2_000).nullable().optional(),
  active: z.boolean().optional(),
  discountType: z.enum(['percentage', 'fixed', 'free_shipping']),
  discountValue: z.coerce.number().finite().min(0).max(10_000_000),
  maxDiscountAmount: z.coerce.number().finite().min(0).max(10_000_000).nullable().optional(),
  appliesTo: z.enum(['eligible_items', 'order']).optional(),
  minOrderAmount: z.coerce.number().finite().min(0).max(10_000_000).nullable().optional(),
  minEligibleQuantity: z.coerce.number().int().min(1).max(1_000_000).nullable().optional(),
  startsAt: z.string().trim().max(80).nullable().optional(),
  endsAt: z.string().trim().max(80).nullable().optional(),
  totalUsageLimit: z.coerce.number().int().min(1).max(1_000_000).nullable().optional(),
  perCustomerUsageLimit: z.coerce.number().int().min(1).max(1_000_000).nullable().optional(),
  loginRequirement: z.enum(['any', 'authenticated', 'guest']).optional(),
  requiresVerifiedEmail: z.boolean().optional(),
  requiresNewsletter: z.boolean().optional(),
  firstOrderOnly: z.boolean().optional(),
  minCustomerOrderCount: z.coerce.number().int().min(0).max(1_000_000).nullable().optional(),
  maxCustomerOrderCount: z.coerce.number().int().min(0).max(1_000_000).nullable().optional(),
  minCustomerLifetimeSpend: z.coerce.number().finite().min(0).max(10_000_000).nullable().optional(),
  allowedShippingMethods: z.array(z.enum(['courier', 'pickup'])).max(2).default([]),
  allowedPaymentMethods: z.array(z.enum(['cod', 'pickup'])).max(2).default([]),
  productRules: z.object({
    include: scopeSchema.default(emptyScopeDefault),
    exclude: scopeSchema.default(emptyScopeDefault)
  }).default({ include: emptyScopeDefault, exclude: emptyScopeDefault }),
  customerTargets: z.object({
    include: idListSchema,
    exclude: idListSchema
  }).default({ include: [], exclude: [] })
});

const audienceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1_000).optional()
});

@Controller('admin/promotions')
export class PromotionsAdminController {
  constructor(private readonly promotions: PromotionsService) {}

  @Get()
  list(@Req() request: Request) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'promotions.read');
    return this.promotions.list(ctx.organizationId);
  }

  @Get('audience')
  audience(@Req() request: Request, @Query() query: Record<string, string | undefined>) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'promotions.read');
    const input = parseWithSchema(audienceQuerySchema, query);
    return this.promotions.audience(ctx.organizationId, input.limit);
  }

  @Post()
  create(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'promotions.write');
    return this.promotions.create(
      ctx.organizationId,
      ctx.userId,
      parseWithSchema(promotionInputSchema, body)
    );
  }

  @Patch(':id')
  update(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'promotions.write');
    return this.promotions.update(
      ctx.organizationId,
      parseWithSchema(uuidSchema, id),
      ctx.userId,
      parseWithSchema(promotionInputSchema, body)
    );
  }

  @Post(':id/duplicate')
  duplicate(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'promotions.write');
    return this.promotions.duplicate(ctx.organizationId, ctx.userId, parseWithSchema(uuidSchema, id));
  }

  @Delete(':id')
  archive(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'promotions.write');
    return this.promotions.archive(ctx.organizationId, parseWithSchema(uuidSchema, id));
  }
}
