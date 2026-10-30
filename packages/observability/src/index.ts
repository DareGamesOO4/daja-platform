import pino, { type DestinationStream } from 'pino';
import type { AppConfig } from '@daja/config';

export function createLogger(config: Pick<AppConfig, 'LOG_LEVEL' | 'NODE_ENV'>, service: string, destination?: DestinationStream) {
  return pino({
    level: config.LOG_LEVEL,
    base: {
      service,
      environment: config.NODE_ENV
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      err: config.NODE_ENV === 'production'
        ? (error: unknown) => ({
            type: error instanceof Error ? error.name : 'Error',
            // Provider error messages/details can contain SQL, PII or URLs.
            code: error && typeof error === 'object' && 'code' in error
              && typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : undefined
          })
        : pino.stdSerializers.err
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
        'headers.cookie',
        'password', 'passwordHash', 'password_hash', 'token', 'accessToken', 'refreshToken',
        'secret', 'authorization', 'cookie', 'pin', 'otp', 'DATABASE_URL', 'REDIS_URL',
        'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'PRIVACY_TOKEN_SECRET', 'MIGRATION_DATABASE_URL',
        'SES_SECRET_ACCESS_KEY', 'SNS_SMS_SECRET_ACCESS_KEY',
        '*.accessToken', '*.refreshToken', '*.passwordHash', '*.pin', '*.otp',
        '*.*.accessToken', '*.*.refreshToken', '*.*.password', '*.*.secret',
        '*.password',
        '*.password_hash',
        '*.token',
        '*.secret',
        'R2_SECRET_ACCESS_KEY'
      ],
      censor: '[REDACTED]'
    }
  }, destination);
}

export type Logger = ReturnType<typeof createLogger>;
