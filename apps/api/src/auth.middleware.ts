import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { createRequestId } from '@daja/shared';
import { AuthService } from './auth.service.js';
import type { RequestWithAuthContext } from './auth.controller.js';

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  async use(request: Request, _response: Response, next: NextFunction): Promise<void> {
    try {
      if (isCustomerRoute(request.path) || isCustomerRoute(request.originalUrl) || isCustomerRoute(request.url)) {
        next();
        return;
      }
      const token = bearerToken(request);
      if (token) {
        const ctx = await this.authService.authenticateAccessToken(token, {
          deviceId: header(request, 'x-device-id'),
          locationId: header(request, 'x-location-id')
        });
        (request as RequestWithAuthContext).authContext = {
          ...ctx,
          requestId: header(request, 'x-request-id') ?? createRequestId(),
          correlationId:
            header(request, 'x-correlation-id') ??
            header(request, 'x-request-id') ??
            createRequestId()
        };
      }
      next();
    } catch (error) {
      next(error);
    }
  }
}

function isCustomerRoute(path: string): boolean {
  const normalized = path.replace(/^\/api\/v1/, '');
  return (
    normalized.startsWith('/customer-auth') ||
    normalized.startsWith('/customers/me') ||
    normalized.startsWith('/orders') ||
    /^\/products\/[^/]+\/reviews$/.test(normalized) ||
    /^\/products\/[^/]+\/alerts$/.test(normalized) ||
    normalized.startsWith('/newsletter/subscribe') ||
    normalized.startsWith('/newsletter/confirm') ||
    normalized.startsWith('/privacy/current') ||
    normalized.startsWith('/privacy/documents') ||
    normalized.startsWith('/privacy/consents') ||
    normalized.startsWith('/privacy/me') ||
    normalized.startsWith('/privacy/unsubscribe')
  );
}

function bearerToken(request: Request): string | undefined {
  const authorization = header(request, 'authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return undefined;
  }
  return authorization.slice('Bearer '.length).trim();
}

function header(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
