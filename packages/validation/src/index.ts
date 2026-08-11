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
  const epc = input.replace(/[\s:._-]/g, '').toUpperCase();
  if (!/^[0-9A-F]{8,64}$/.test(epc)) {
    throw new ValidationFailedError('Malformed EPC', {
      policy: 'EPC must be 8-64 hexadecimal characters after removing spaces and separators'
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
