import { randomUUID } from 'node:crypto';
export * from './email-template.js';

export interface RequestContext {
  requestId: string;
  correlationId: string;
  organizationId: string;
  userId: string;
  deviceId?: string;
  locationId?: string;
  roles: string[];
  permissions: string[];
  scopedGrants?: Array<{
    permission: string;
    scope: 'location' | 'all_locations';
    locationId?: string;
  }>;
  policyVersion?: number;
  isOwner?: boolean;
}

// Background metadata work has no acting user and must not impersonate one.
export type SystemRequestContext = Omit<RequestContext, 'userId'> & { userId: null };

export function createRequestId(): string {
  return randomUUID();
}
