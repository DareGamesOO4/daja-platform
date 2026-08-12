import { Body, Controller, Get, Headers, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthenticationRequiredError, ValidationFailedError } from '@daja/security';
import type { RequestContext } from '@daja/shared';
import { AuthService } from './auth.service.js';
import { resolveRequestContext } from './runtime/request-context.js';

const loginSchema = z.object({
  organizationId: z.string().uuid(),
  email: z.string().email(),
  password: z.string().min(1),
  deviceId: z.string().uuid()
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1)
});

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

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
