export const ERROR_CODES = {
  authenticationRequired: 'AUTHENTICATION_REQUIRED',
  invalidCredentials: 'INVALID_CREDENTIALS',
  invalidToken: 'INVALID_TOKEN',
  resourceVersionConflict: 'RESOURCE_VERSION_CONFLICT',
  tenantAccessDenied: 'TENANT_ACCESS_DENIED',
  idempotencyConflict: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
  validationFailed: 'VALIDATION_FAILED',
  permissionDenied: 'PERMISSION_DENIED',
  notFound: 'NOT_FOUND',
  conflict: 'CONFLICT',
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

export class AuthenticationRequiredError extends AppError {
  constructor(message = 'Authentication is required') {
    super(ERROR_CODES.authenticationRequired, message, 401);
  }
}

export class InvalidCredentialsError extends AppError {
  constructor() {
    super(ERROR_CODES.invalidCredentials, 'Invalid credentials', 401);
  }
}

export class InvalidTokenError extends AppError {
  constructor(message = 'Invalid authentication token') {
    super(ERROR_CODES.invalidToken, message, 401);
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

export class ValidationFailedError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(ERROR_CODES.validationFailed, message, 400, details);
  }
}

export class PermissionDeniedError extends AppError {
  constructor(permission: string) {
    super(ERROR_CODES.permissionDenied, 'Permission denied', 403, { permission });
  }
}

export class ResourceNotFoundError extends AppError {
  constructor(resource: string) {
    super(ERROR_CODES.notFound, 'Resource not found', 404, { resource });
  }
}

export class ResourceConflictError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(ERROR_CODES.conflict, message, 409, details);
  }
}

export function requirePermission(ctx: { permissions: string[] }, permission: string): void {
  if (!ctx.permissions.includes(permission)) {
    throw new PermissionDeniedError(permission);
  }
}

export * from './jwt.js';
