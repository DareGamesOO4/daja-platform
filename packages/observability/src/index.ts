import pino from 'pino';
import type { AppConfig } from '@daja/config';

export function createLogger(config: Pick<AppConfig, 'LOG_LEVEL' | 'NODE_ENV'>, service: string) {
  return pino({
    level: config.LOG_LEVEL,
    base: {
      service,
      environment: config.NODE_ENV
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
        'headers.cookie',
        '*.password',
        '*.password_hash',
        '*.token',
        '*.secret',
        'R2_SECRET_ACCESS_KEY'
      ],
      censor: '[REDACTED]'
    }
  });
}

export type Logger = ReturnType<typeof createLogger>;
