import { z } from 'zod';

const optionalPreparedSecret = z.string().optional().default('');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']),
  PORT: z.coerce.number().int().positive().max(65535),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  EDGE_SHARED_SECRET: z.string().default(''),
  EDGE_ENFORCEMENT: z.enum(['off', 'observe', 'enforce']).default('off'),
  BROWSER_SESSIONS_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  DATABASE_URL: z.string().url(),
  MIGRATION_DATABASE_URL: optionalPreparedSecret,
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
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(14_400),
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
  SES_CONFIGURATION_SET: z.string().default('my-first-configuration-set'),
  SES_FEEDBACK_QUEUE_NAME: z.string().default('dajashop-email-feedback'),
  CONTACT_NOTIFICATION_EMAIL: z.string().email().default('cvelenis42@yahoo.com'),
  ORDER_NOTIFICATION_EMAILS: optionalPreparedSecret,
  WHATSAPP_OTP_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  WHATSAPP_OTP_TEMPLATES_APPROVED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  WHATSAPP_ACCESS_TOKEN: optionalPreparedSecret,
  WHATSAPP_PHONE_NUMBER_ID: z.string().regex(/^\d*$/).default(''),
  WHATSAPP_GRAPH_API_VERSION: z.string().regex(/^(v\d+\.0)?$/).default(''),
  WHATSAPP_OTP_TEMPLATE_NAME: z.string().regex(/^[a-z0-9_]+$/).default('daja_verification_v1'),
  WHATSAPP_OTP_SECRET: optionalPreparedSecret,
  WHATSAPP_OTP_DAILY_LIMIT: z.coerce.number().int().min(1).max(10000).default(100),
  WHATSAPP_NOTIFICATIONS_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  WHATSAPP_NOTIFICATION_TEMPLATES_APPROVED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  WHATSAPP_BUSINESS_PHONE: z.string().regex(/^(\+[1-9]\d{7,14})?$/).default(''),
  WHATSAPP_APP_SECRET: optionalPreparedSecret,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: optionalPreparedSecret,
  WHATSAPP_NEWSLETTER_TEMPLATE: z.string().regex(/^[a-z0-9_]+$/).default('daja_newsletter_v1'),
  WHATSAPP_PRICE_TEMPLATE: z.string().regex(/^[a-z0-9_]+$/).default('daja_price_change_v1'),
  WHATSAPP_STOCK_TEMPLATE: z.string().regex(/^[a-z0-9_]+$/).default('daja_back_in_stock_v1'),
  WHATSAPP_NOTIFICATION_DAILY_LIMIT: z.coerce.number().int().min(1).max(10000).default(100),
  FIREBASE_PHONE_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  FIREBASE_PHONE_PROJECT_ID: z.string().default(''),
  FIREBASE_PHONE_API_KEY: z.string().default(''),
  FIREBASE_PHONE_APP_ID: z.string().default(''),
  PRIVACY_TOKEN_SECRET: optionalPreparedSecret,
  STOREFRONT_PUBLIC_BASE_URL: z.string().url().default('https://dajashop.rs'),
  STOREFRONT_SHIPPING_COST_RSD: z.coerce.number().min(0).default(380),
  STOREFRONT_FREE_SHIPPING_THRESHOLD_RSD: z.coerce.number().min(0).default(8000),
  STOREFRONT_DELIVERY_MIN_DAYS: z.coerce.number().int().min(0).default(1),
  STOREFRONT_DELIVERY_MAX_DAYS: z.coerce.number().int().min(0).default(3),
  STOREFRONT_RETURN_DAYS: z.coerce.number().int().min(0).default(14),
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

  if ((parsed.data.EDGE_ENFORCEMENT === 'enforce' || parsed.data.BROWSER_SESSIONS_ENABLED)
    && parsed.data.EDGE_SHARED_SECRET.length < 32) throw new Error('EDGE_SHARED_SECRET must be configured before enabling edge enforcement or browser sessions');
  return parsed.data;
}
