import { isIP } from 'node:net';
import type { RequestHandler } from 'express';

/** Group IPv6 privacy addresses by /64; never key counters by caller headers. */
export function clientNetwork(address: string): string {
  if (isIP(address) !== 6) return address;
  const [left = '', right = ''] = address.toLowerCase().split('::');
  const start = left ? left.split(':') : [];
  const end = right ? right.split(':') : [];
  // IPv4-mapped addresses must share the IPv4 budget.
  if (address.toLowerCase().startsWith('::ffff:') && isIP(end[end.length - 1] ?? '') === 4) {
    return end[end.length - 1]!;
  }
  const words = [...start, ...Array<string>(Math.max(0, 8 - start.length - end.length)).fill('0'), ...end];
  return words.slice(0, 4).map(word => Number.parseInt(word, 16).toString(16)).join(':') + '::/64';
}

/** Fixed windows and bounded storage: a flood must not grow a limiter forever. */
export class AdmissionBudget {
  private readonly entries = new Map<string, { hits: number; until: number }>();
  private nextSweep = 0;

  constructor(private readonly capacity = 10_000) {}

  take(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    if (now >= this.nextSweep) {
      for (const [entryKey, value] of this.entries) if (value.until <= now) this.entries.delete(entryKey);
      this.nextSweep = now + 10_000;
    }
    let entry = this.entries.get(key);
    if (!entry || entry.until <= now) {
      if (!entry && this.entries.size >= this.capacity) return false;
      entry = { hits: 0, until: now + windowMs };
      this.entries.set(key, entry);
    }
    if (entry.hits >= limit) return false;
    entry.hits++;
    return true;
  }
}

export function admissionMiddleware(): RequestHandler {
  const budget = new AdmissionBudget();
  const active = new Map<string, number>();
  let total = 0;
  return (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    const network = clientNetwork(request.ip ?? request.socket.remoteAddress ?? 'unknown');
    if (request.path === '/health/live' || request.path === '/health/ready') {
      // Separate budget keeps probes independent of normal API saturation.
      if (budget.take('health-global', 300, 60_000) && budget.take(`health:${network}`, 60, 60_000)) return next();
      response.setHeader('Retry-After', '60');
      response.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests', details: {} } });
      return;
    }
    if (!budget.take('global', 6000, 60_000) || !budget.take(network, 1200, 60_000)) {
      response.setHeader('Retry-After', '60');
      response.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests', details: {} } });
      return;
    }
    if (total >= 64 || (active.get(network) ?? 0) >= 16) {
      response.setHeader('Retry-After', '5');
      response.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable', details: {} } });
      return;
    }
    total++;
    active.set(network, (active.get(network) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      total--;
      const remaining = (active.get(network) ?? 1) - 1;
      if (remaining) active.set(network, remaining);
      else active.delete(network);
    };
    response.once('finish', release);
    response.once('close', release);
    next();
  };
}
