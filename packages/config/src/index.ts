import { z } from 'zod';

const optionalPreparedSecret = z.string().optional().default('');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']),
  PORT: z.coerce.number().int().positive().max(65535),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  API_PUBLIC_BASE_URL: z.string().url(),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    )
    .pipe(z.array(z.string().url()).min(1)),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_SLOW_QUERY_MS: z.coerce.number().int().positive().default(250),
  JWT_ACCESS_SECRET: optionalPreparedSecret,
  JWT_REFRESH_SECRET: optionalPreparedSecret,
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2592000),
  TRUSTED_IDENTITY_HEADERS: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((value) => value === 'true'),
  R2_ACCOUNT_ID: optionalPreparedSecret,
  R2_BUCKET: optionalPreparedSecret,
  R2_ACCESS_KEY_ID: optionalPreparedSecret,
  R2_SECRET_ACCESS_KEY: optionalPreparedSecret,
  R2_ENDPOINT: optionalPreparedSecret,
  MEDIA_PUBLIC_BASE_URL: optionalPreparedSecret,
  PUBLIC_ORGANIZATION_ID: optionalPreparedSecret,
  FIRESTORE_SERVICE_ACCOUNT_JSON: optionalPreparedSecret,
  FIRESTORE_PROJECT_ID: optionalPreparedSecret,
  GOOGLE_OAUTH_CLIENT_ID: optionalPreparedSecret,
  GOOGLE_OAUTH_CLIENT_SECRET: optionalPreparedSecret,
  GOOGLE_OAUTH_CALLBACK_BASE_URL: optionalPreparedSecret,
  OAUTH_FRONTEND_REDIRECT_URL: optionalPreparedSecret,
  SES_REGION: z.string().trim().min(1).default('eu-north-1'),
  SES_ACCESS_KEY_ID: optionalPreparedSecret,
  SES_SECRET_ACCESS_KEY: optionalPreparedSecret,
  SES_FROM_EMAIL: optionalPreparedSecret,
  SES_ACCOUNT_FROM_EMAIL: optionalPreparedSecret,
  SES_ORDER_FROM_EMAIL: optionalPreparedSecret,
  SES_REPLY_TO_EMAIL: optionalPreparedSecret,
  ORDER_NOTIFICATION_EMAILS: optionalPreparedSecret,
  PRIVACY_TOKEN_SECRET: optionalPreparedSecret,
  STOREFRONT_PUBLIC_BASE_URL: z.string().url().default('https://dajashop.rs'),
  // Comma-separated email allowlist. These storefront customers may exchange a
  // verified customer session for a real staff/admin session.
  STOREFRONT_ADMIN_EMAILS: optionalPreparedSecret
  ,OFFLINE_PACKAGE_SIGNING_PRIVATE_KEY: optionalPreparedSecret
  ,OFFLINE_LEASE_SIGNING_PRIVATE_KEY: optionalPreparedSecret
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment configuration: ${details.join('; ')}`);
  }

  return parsed.data;
}
