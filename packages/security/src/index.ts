export const ERROR_CODES = {
  resourceVersionConflict: 'RESOURCE_VERSION_CONFLICT',
  tenantAccessDenied: 'TENANT_ACCESS_DENIED',
  idempotencyConflict: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
  validationFailed: 'VALIDATION_FAILED',
  internal: 'INTERNAL_ERROR',
  unavailable: 'SERVICE_UNAVAILABLE'
} as const;

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

export class VersionConflictError extends AppError {
  constructor() {
    super(ERROR_CODES.resourceVersionConflict, 'Resource version conflict', 409);
  }
}

export class TenantAccessDeniedError extends AppError {
  constructor() {
    super(
      ERROR_CODES.tenantAccessDenied,
      'The resource is not available in this organization',
      404
    );
  }
}

export class IdempotencyConflictError extends AppError {
  constructor() {
    super(
      ERROR_CODES.idempotencyConflict,
      'Idempotency key was reused with a different request',
      409
    );
  }
}
