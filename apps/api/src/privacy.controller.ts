import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AppConfig } from '@daja/config';
import { requirePermission, ValidationFailedError } from '@daja/security';
import { parseWithSchema, uuidSchema } from '@daja/validation';
import { CustomerAuthService } from './customer-auth.service.js';
import { CONFIG } from './tokens.js';
import { PolicyPublicationService } from './policy-publication.service.js';
import { PrivacyService } from './privacy.service.js';
import { resolveRequestContext } from './runtime/request-context.js';

const consentSchema = z.object({
  receipt: z.string().min(24).max(160).optional(),
  policyVersion: z.string().trim().min(1).max(120).optional(),
  categories: z.object({
    preferences: z.boolean().default(false),
    externalGoogle: z.boolean().default(false),
    analytics: z.boolean().default(false)
  }),
  action: z.enum(['granted', 'updated', 'revoked', 'policy_reset']).optional()
});

const publicationSchema = z.object({
  version: z.string().trim().min(1).max(120),
  material: z.boolean(),
  changeSummary: z.string().trim().min(1).max(4000),
  effectiveAt: z.string().datetime().optional()
});

@Controller('privacy')
export class PrivacyController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly privacy: PrivacyService,
    private readonly customerAuth: CustomerAuthService,
    private readonly publications: PolicyPublicationService
  ) {}

  @Get('current')
  current() {
    return this.privacy.currentPolicy(publicOrganizationId(this.config));
  }

  @Get('documents')
  documents() {
    return this.privacy.currentPolicy(publicOrganizationId(this.config));
  }

  @Get('documents/:kind')
  document(@Param('kind') kind: string) {
    if (kind !== 'privacy' && kind !== 'cookies' && kind !== 'terms') {
      throw new ValidationFailedError('Nepoznat pravni dokument.');
    }
    return this.privacy.document(kind, publicOrganizationId(this.config));
  }

  @Post('consents')
  async recordConsent(@Req() request: Request, @Body() body: unknown) {
    const input = parseWithSchema(consentSchema, body);
    const customer = await this.optionalCustomer(request);
    return this.privacy.recordConsent({
      organizationId: customer?.organizationId ?? publicOrganizationId(this.config),
      customerId: customer?.customerId ?? null,
      receipt: input.receipt,
      policyVersion: input.policyVersion,
      categories: input.categories,
      action: input.action
    });
  }

  @Get('me')
  async mine(@Req() request: Request) {
    const customer = await this.requiredCustomer(request);
    const organizationId = customer.organizationId;
    return {
      policy: await this.privacy.currentPolicy(organizationId),
      ...(await this.privacy.customerSnapshot({
        organizationId,
        customerId: customer.customerId,
        email: customer.email
      }))
    };
  }

  @Delete('me/newsletter')
  async unsubscribeMyNewsletter(@Req() request: Request) {
    const customer = await this.requiredCustomer(request);
    if (!customer.email) throw new ValidationFailedError('Nalog nema email adresu.');
    const result = await this.privacy.newsletterSubscriber({
      organizationId: customer.organizationId,
      email: customer.email
    });
    if (!result?.id) return { unsubscribed: false };
    return {
      unsubscribed: await this.privacy.unsubscribeNewsletterById({
        organizationId: customer.organizationId,
        subscriberId: result.id,
        customerId: customer.customerId,
        source: 'account'
      })
    };
  }

  @Delete('me/alerts/:id')
  async unsubscribeMyAlert(@Req() request: Request, @Param('id') id: string) {
    const customer = await this.requiredCustomer(request);
    return {
      unsubscribed: await this.privacy.revokeProductAlertSubscription({
        organizationId: customer.organizationId,
        subscriptionId: parseWithSchema(uuidSchema, id),
        customerId: customer.customerId,
        customerEmail: customer.email,
        source: 'account'
      })
    };
  }

  @Get('unsubscribe/newsletter')
  async newsletterUnsubscribe(@Query('token') token: string | undefined, @Res() response: Response) {
    const unsubscribed = token ? await this.privacy.unsubscribeNewsletterToken(token) : false;
    return response.redirect(this.unsubscribeRedirect('newsletter', unsubscribed));
  }

  @Get('unsubscribe/product-alert')
  async productAlertUnsubscribe(@Query('token') token: string | undefined, @Res() response: Response) {
    const unsubscribed = token ? await this.privacy.unsubscribeProductAlertToken(token) : false;
    return response.redirect(this.unsubscribeRedirect('product-alert', unsubscribed));
  }

  @Get('admin/publications')
  async listPublications(@Req() request: Request) {
    const context = resolveRequestContext(request);
    requirePermission(context, 'privacy.manage');
    return this.publications.list(context.organizationId);
  }

  @Post('admin/publications')
  async publish(@Req() request: Request, @Body() body: unknown) {
    const context = resolveRequestContext(request);
    requirePermission(context, 'privacy.manage');
    const input = parseWithSchema(publicationSchema, body);
    return this.publications.publish({
      organizationId: context.organizationId,
      userId: context.userId,
      version: input.version,
      material: input.material,
      changeSummary: input.changeSummary,
      ...(input.effectiveAt ? { effectiveAt: new Date(input.effectiveAt) } : {})
    });
  }

  private async optionalCustomer(request: Request) {
    const token = bearerToken(request);
    return token ? this.customerAuth.authenticateAccessToken(token).catch(() => null) : null;
  }

  private async requiredCustomer(request: Request) {
    // Let the storefront recognize an expired customer session, refresh its
    // access token, and retry this request instead of showing a false prompt.
    return this.customerAuth.requireCustomer(bearerToken(request));
  }

  private unsubscribeRedirect(kind: string, success: boolean): string {
    const url = new URL('/unsubscribe', this.config.STOREFRONT_PUBLIC_BASE_URL);
    url.searchParams.set('kind', kind);
    url.searchParams.set('status', success ? 'success' : 'already_unsubscribed');
    return url.toString();
  }
}

function publicOrganizationId(config: AppConfig): string {
  if (!config.PUBLIC_ORGANIZATION_ID) {
    throw new ValidationFailedError('PUBLIC_ORGANIZATION_ID is required for privacy routes.');
  }
  return config.PUBLIC_ORGANIZATION_ID;
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.authorization;
  return authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : undefined;
}
