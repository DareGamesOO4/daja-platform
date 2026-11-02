import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError, ERROR_CODES } from '@daja/security';
import { browserRequest } from './edge-ingress.js';
import { clearBrowserSession } from './browser-session.js';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { id?: string }>();
    const requestId = request.id ?? response.getHeader('x-request-id')?.toString() ?? 'unknown';

    if (exception instanceof AppError) {
      if (exception.statusCode === 401 && request.path === '/api/v1/customer-auth/refresh' && browserRequest(request)) {
        // JavaScript cannot clear HttpOnly cookies. A revoked refresh family
        // must be removed by the server, or a later session probe could keep
        // rediscovering its still-signed cookie and retrying indefinitely.
        clearBrowserSession(response);
      }
      if (exception.statusCode === 429 && !response.hasHeader('Retry-After')) {
        const seconds = exception.details.retryAfterSeconds;
        if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
          response.setHeader('Retry-After', Math.ceil(seconds));
        }
      }
      if (exception.statusCode === 503 && !response.hasHeader('Retry-After')) response.setHeader('Retry-After', '5');
      response.status(exception.statusCode).json({
        error: {
          code: exception.code,
          message: exception.statusCode >= 500 ? 'Service temporarily unavailable' : exception.message,
          details: exception.statusCode >= 500 ? {} : exception.details,
          requestId
        }
      });
      return;
    }

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json({
        error: {
          code: exception.getStatus() === 429 ? 'RATE_LIMITED' : ERROR_CODES.validationFailed,
          message: exception.getStatus() >= 500 ? 'Service temporarily unavailable' : exception.message,
          details: {},
          requestId
        }
      });
      return;
    }

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: {
        code: ERROR_CODES.internal,
        message: 'Internal server error',
        details: {},
        requestId
      }
    });
  }
}
