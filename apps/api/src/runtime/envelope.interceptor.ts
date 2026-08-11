import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ id?: string; url: string }>();
    if (request.url.includes('/docs')) {
      return next.handle();
    }
    return next.handle().pipe(
      map((data: unknown) => ({
        data,
        meta: {},
        requestId: request.id ?? 'unknown'
      }))
    );
  }
}
