import type { Request } from 'express';
import { createRequestId, type RequestContext } from '@daja/shared';

export function resolveRequestContext(request: Request): RequestContext {
  const requestId = header(request, 'x-request-id') ?? createRequestId();
  const correlationId = header(request, 'x-correlation-id') ?? requestId;
  const organizationId = requiredHeader(request, 'x-organization-id');
  const userId = requiredHeader(request, 'x-user-id');
  const roles = splitHeader(header(request, 'x-roles'));
  const permissions = splitHeader(header(request, 'x-permissions'));
  const locationId = header(request, 'x-location-id');
  const deviceId = header(request, 'x-device-id');

  return {
    requestId,
    correlationId,
    organizationId,
    userId,
    roles,
    permissions,
    ...(locationId ? { locationId } : {}),
    ...(deviceId ? { deviceId } : {})
  };
}

function requiredHeader(request: Request, name: string): string {
  const value = header(request, name);
  if (!value) {
    throw new Error(`Missing required request identity header: ${name}`);
  }
  return value;
}

function header(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function splitHeader(value: string | undefined): string[] {
  return value
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}
