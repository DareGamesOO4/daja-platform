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
  scopedGrants?: Array<{
    permission: string;
    scope: 'location' | 'all_locations';
    locationId?: string;
  }>;
  policyVersion?: number;
  isOwner?: boolean;
}

export function createRequestId(): string {
  return randomUUID();
}
