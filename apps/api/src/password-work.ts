import { argon2id, hash as argonHash, verify as argonVerify, type Options } from 'argon2';
import { AppError, ERROR_CODES } from '@daja/security';

// Argon2 allocates tens of MB per invocation. Reject excess work immediately,
// rather than retaining an unbounded queue of passwords and open DB clients.
let active = 0;
async function bounded<T>(work: () => Promise<T>): Promise<T> {
  if (active >= 2) throw new AppError(ERROR_CODES.unavailable, 'Service temporarily unavailable', 503);
  active++;
  try { return await work(); }
  finally { active--; }
}

export { argon2id };
export const hash = (password: string, options?: Options): Promise<string> => bounded(() => argonHash(password, options));
export const verify: typeof argonVerify = (digest, password, options) => bounded(() => argonVerify(digest, password, options));
