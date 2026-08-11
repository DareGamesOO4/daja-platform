import { randomUUID } from 'node:crypto';

export interface RequestContext {
  requestId: string;
  correlationId: string;
  organizationId: string;
  userId: string;
  deviceId?: string;
  locationId?: string;
  roles: string[];
  permissions: string[];
}

export function createRequestId(): string {
  return randomUUID();
}
