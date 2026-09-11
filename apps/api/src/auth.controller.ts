import { Body, Controller, Get, Headers, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthenticationRequiredError, ValidationFailedError } from '@daja/security';
import { requirePermission } from '@daja/security';
import type { RequestContext } from '@daja/shared';
import { AuthService } from './auth.service.js';
import { DesktopGoogleOAuthService } from './desktop-google-oauth.service.js';
import { resolveRequestContext } from './runtime/request-context.js';

const loginSchema = z.object({
  // Reader users sign in by their own identity; the server resolves the
  // organization only when that email belongs to exactly one tenant.
  organizationId: z.string().uuid().optional(),
  email: z.string().email(),
  password: z.string().min(1),
  deviceId: z.string().uuid(),
  // Optional so existing desktop clients keep their exact login contract.
  deviceType: z.enum(['rfiddaja_desktop', 'rfiddaja_mobile']).optional(),
  deviceName: z.string().trim().min(1).max(240).optional()
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1)
});

const desktopGoogleStartSchema = z.object({
  organizationId: z.string().uuid(),
  deviceId: z.string().uuid(),
  callbackUrl: z.string().url().max(500),
  state: z.string().min(32).max(200)
});

const desktopGoogleExchangeSchema = z.object({
  organizationId: z.string().uuid(),
  deviceId: z.string().uuid(),
  grant: z.string().min(32).max(200)
});

const nfcCardIdSchema = z.string().regex(/^daja_[0-9a-f]{32}$/);
const nfcCardLoginSchema = z.object({
  cardId: nfcCardIdSchema,
  pin: z.string().regex(/^\d{4}$/),
  deviceId: z.string().uuid(),
  deviceType: z.enum(['rfiddaja_desktop', 'rfiddaja_mobile']).optional(),
  deviceName: z.string().trim().min(1).max(240).optional()
});
const nfcCardBindSchema = z.object({
  userEmail: z.string().trim().email(),
  cardId: nfcCardIdSchema,
  pin: z.string().regex(/^\d{4}$/)
});
const nfcCardIdentifySchema = z.object({ cardId: nfcCardIdSchema });

const mobileGoogleStartSchema = z.object({
  email: z.string().email(),
  deviceId: z.string().uuid(),
  state: z.string().min(32).max(200)
});

const mobileGoogleExchangeSchema = z.object({
  deviceId: z.string().uuid(),
  grant: z.string().min(32).max(200)
});

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(DesktopGoogleOAuthService) private readonly desktopGoogle: DesktopGoogleOAuthService
  ) {}

  @Post('desktop/google/start')
  desktopGoogleStart(@Body() body: unknown) {
    return this.desktopGoogle.start(parseBody(desktopGoogleStartSchema, body));
  }

  @Post('desktop/google/exchange')
  desktopGoogleExchange(@Body() body: unknown) {
    return this.desktopGoogle.exchange(parseBody(desktopGoogleExchangeSchema, body));
  }

  @Post('mobile/google/start')
  mobileGoogleStart(@Body() body: unknown) {
    return this.desktopGoogle.startMobile(parseBody(mobileGoogleStartSchema, body));
  }

  @Post('mobile/google/exchange')
  mobileGoogleExchange(@Body() body: unknown) {
    return this.desktopGoogle.exchangeMobile(parseBody(mobileGoogleExchangeSchema, body));
  }

  @Post('login')
  async login(
    @Body() body: unknown,
    @Headers('x-request-id') requestId?: string,
    @Headers('x-correlation-id') correlationId?: string
  ) {
    const input = parseBody(loginSchema, body);
    const result = await this.authService.login({ ...input, requestId, correlationId });
    return {
      ...result.tokens,
      user: serializePrincipal(result.principal)
    };
  }

  @Post('card/login')
  async loginWithCard(@Body() body: unknown) {
    const result = await this.authService.loginWithNfcCard(parseBody(nfcCardLoginSchema, body));
    return { ...result.tokens, user: serializePrincipal(result.principal) };
  }

  @Post('card/identify')
  async identifyCard(@Body() body: unknown) {
    return this.authService.identifyNfcCard(parseBody(nfcCardIdentifySchema, body));
  }

  @Post('cards/bind')
  async bindCard(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'admin.users');
    await this.authService.bindNfcCard({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      deviceId: ctx.deviceId,
      ...parseBody(nfcCardBindSchema, body)
    });
    return { ok: true };
  }

  @Post('refresh')
  async refresh(@Body() body: unknown) {
    const result = await this.authService.refresh(parseBody(refreshSchema, body));
    return {
      ...result.tokens,
      user: serializePrincipal(result.principal)
    };
  }

  @Post('logout')
  async logout(@Req() request: Request) {
    const ctx = resolveRequestContext(request);
    await this.authService.logout(ctx);
    return { ok: true };
  }

  @Get('me')
  me(@Req() request: Request) {
    const ctx = resolveRequestContext(request);
    if (!ctx.userId) {
      throw new AuthenticationRequiredError();
    }
    return {
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      deviceId: ctx.deviceId,
      locationId: ctx.locationId,
      roles: ctx.roles,
      permissions: ctx.permissions
    };
  }
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationFailedError('Invalid request body', { issues: parsed.error.issues });
  }
  return parsed.data;
}

function serializePrincipal(principal: {
  userId: string;
  organizationId: string;
  email: string;
  displayName: string;
  active: boolean;
  deviceId: string;
  sessionFamilyId: string;
  roles: string[];
  permissions: string[];
}) {
  return {
    userId: principal.userId,
    organizationId: principal.organizationId,
    email: principal.email,
    displayName: principal.displayName,
    active: principal.active,
    deviceId: principal.deviceId,
    sessionFamilyId: principal.sessionFamilyId,
    roles: principal.roles,
    permissions: principal.permissions
  };
}

export type RequestWithAuthContext = Request & {
  authContext?: RequestContext & { sessionId?: string };
};
