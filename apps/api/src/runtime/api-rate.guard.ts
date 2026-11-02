import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerRequest } from '@nestjs/throttler';
import type { Response } from 'express';
import { AppError } from '@daja/security';
import type { RequestWithAuthContext } from '../auth.controller.js';
import { clientNetwork } from './abuse-protection.js';
import { SharedRateStorage } from './shared-rate-storage.js';

@Injectable()
export class ApiRateGuard extends ThrottlerGuard {
  protected override async handleRequest(props: ThrottlerRequest): Promise<boolean> {
    const request = props.context.switchToHttp().getRequest<RequestWithAuthContext>();
    const response = props.context.switchToHttp().getResponse<Response>();
    const path = request.path.replace(/^\/api\/v1/, '');
    const network = clientNetwork(request.ip ?? request.socket.remoteAddress ?? 'unknown');
    const storage = this.storageService as SharedRateStorage;
    if (/^\/public\/catalog(?:\/|$)/.test(path)) {
      const bucket = await storage.tokenBucket(`public-catalog:${network}`, 200, 30);
      response.setHeader('X-RateLimit-Limit', '200');
      response.setHeader('X-RateLimit-Burst', '30');
      response.setHeader('X-RateLimit-Remaining', bucket.remaining);
      response.setHeader('X-RateLimit-Reset', bucket.resetSeconds);
      if (!bucket.allowed) {
        response.setHeader('Retry-After', bucket.retryAfter);
        throw new AppError('RATE_LIMITED', 'Too many requests', 429, {
          retryAfterSeconds: bucket.retryAfter
        });
      }
      return true;
    }
    const ctx = request.authContext;
    if (ctx) {
      const sync = /^\/sync(?:\/|$)/.test(path);
      const read = request.method === 'GET' || request.method === 'HEAD';
      // These budgets are shared across routes, not multiplied per handler.
      const group = sync
        ? `sync:${ctx.deviceId ?? ctx.userId}`
        : `${read ? 'read' : 'write'}:${ctx.userId}`;
      const budget = sync ? 120 : read ? 600 : 120;
      const result = await storage.increment(
        `staff:${ctx.organizationId}:${group}`,
        60_000,
        budget,
        60_000,
        'group'
      );
      if (result.isBlocked) {
        response.setHeader('Retry-After', result.timeToBlockExpire);
        throw new AppError('RATE_LIMITED', 'Too many requests', 429, {
          retryAfterSeconds: result.timeToBlockExpire
        });
      }
      const allowed = await super.handleRequest({
        ...props,
        limit: Math.min(props.limit, budget),
        getTracker: sync
          ? async () => `device:${ctx.organizationId}:${ctx.deviceId ?? ctx.userId}`
          : props.getTracker
      });
      response.setHeader(
        'X-RateLimit-Remaining',
        Math.min(Number(response.getHeader('X-RateLimit-Remaining')), budget - result.totalHits)
      );
      return allowed;
    }
    return super.handleRequest(props);
  }
}
