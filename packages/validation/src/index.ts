import { z } from 'zod';

export const uuidSchema = z.uuid();

export function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}
