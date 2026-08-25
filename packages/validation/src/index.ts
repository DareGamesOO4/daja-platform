import { z } from 'zod';
import { ValidationFailedError } from '@daja/security';

export const uuidSchema = z.uuid();
export const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const currencySchema = z
  .string()
  .trim()
  .length(3)
  .transform((value) => value.toUpperCase());
export const amountMinorSchema = z.coerce.number().int().min(0).max(2_147_483_647);
export const paginationLimitSchema = z.coerce.number().int().min(1).max(50).default(20);
export const syncLimitSchema = z.coerce.number().int().min(1).max(500).default(100);

// Desktop is an offline-first operational client, so its outbox includes the
// complete set of domain aggregates it can mutate locally. Keep this in sync
// with RFIDDaja's BusinessService aggregate types.
export const syncAggregateTypeSchema = z.enum([
  'product',
  'variant',
  'product_variant',
  'inventory_item',
  'rfid_tag',
  'inventory_event',
  'inventory_relocation',
  'cycle_count',
  'goods_receipt',
  'sale',
  'return',
  'transfer',
  'user',
  'location',
  'warehouse',
  'warehouse_zone',
  'category',
  'supplier',
  'warehouse_bin',
  'app_setting',
  'role'
]);

export const syncPushEventSchema = z.object({
  eventId: uuidSchema,
  idempotencyKey: z.string().trim().min(8).max(240),
  aggregateType: syncAggregateTypeSchema,
  aggregateId: uuidSchema,
  operation: z.string().trim().min(1).max(120),
  // A newly created local aggregate has no prior server revision. Desktop
  // represents that explicitly as 0, while updates use a positive version.
  baseVersion: z.coerce.number().int().nonnegative().nullable().optional(),
  payloadVersion: z.coerce.number().int().positive().default(1),
  clientTimestamp: z.string().datetime().optional(),
  locationId: uuidSchema.optional(),
  deviceSequence: z.coerce.number().int().nonnegative().optional(),
  basePayload: z.record(z.string(), z.unknown()).optional(),
  offlinePackageId: uuidSchema.optional(),
  baselineRevision: z.coerce.number().int().nonnegative().optional(),
  correlationId: z.string().trim().min(1).max(200).optional(),
  businessCommandId: uuidSchema.optional(),
  payload: z.record(z.string(), z.unknown()).default({})
});

export const syncPushSchema = z.object({
  events: z.array(syncPushEventSchema).min(1).max(100)
});
export const attributesSchema = z
  .record(z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/), z.unknown())
  .default({})
  .superRefine((value, ctx) => {
    const encoded = JSON.stringify(value);
    if (encoded.length > 32_768) {
      ctx.addIssue({ code: 'custom', message: 'Attributes payload is too large' });
    }
    for (const [key, item] of Object.entries(value)) {
      if (!isAllowedJsonAttribute(item)) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'Unsupported attribute value' });
      }
    }
  });

export function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationFailedError('Validation failed', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message
      }))
    });
  }
  return parsed.data;
}

export function normalizeEpc(input: string): string {
  const epc = input
    .trim()
    .replace(/^0x/i, '')
    .replace(/[\s:._-]/g, '')
    .toUpperCase();
  if (!/^[0-9A-F]{8,64}$/.test(epc) || epc.length % 2 !== 0) {
    throw new ValidationFailedError('Malformed EPC', {
      policy:
        'EPC must be 8-64 hexadecimal characters with an even length after removing the 0x prefix, spaces and separators'
    });
  }
  return epc;
}

function isAllowedJsonAttribute(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length <= 100 && value.every(isAllowedJsonAttribute);
  }
  if (typeof value === 'object') {
    return Object.keys(value).length <= 50;
  }
  return false;
}
