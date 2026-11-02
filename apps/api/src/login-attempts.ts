import type { AppConfig } from '@daja/config';
import { AppError } from '@daja/security';
import { SharedRateStorage } from './runtime/shared-rate-storage.js';

let storage: SharedRateStorage | undefined;

/** Accounts share budgets across IPs; retain the longer brute-force ceiling. */
export async function consumeLoginAttempt(config: AppConfig, account: string): Promise<void> {
  storage ??= new SharedRateStorage(config);
  const minute = await storage.window(`account:minute:${account}`, 5, 60_000);
  if (!minute.allowed) {
    throw new AppError('RATE_LIMITED', 'Too many login attempts. Try again later.', 429,
      { retryAfterSeconds: minute.retryAfter });
  }
  const longer = await storage.window(`account:quarter-hour:${account}`, 20, 900_000);
  if (!longer.allowed) {
    throw new AppError('RATE_LIMITED', 'Too many login attempts. Try again later.', 429,
      { retryAfterSeconds: longer.retryAfter });
  }
}
