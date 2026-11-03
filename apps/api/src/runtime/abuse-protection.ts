import { mediaProcessingActive } from '@daja/database';
import { isIP } from 'node:net';
import type { RequestHandler } from 'express';
import type { SharedRateStorage } from './shared-rate-storage.js';

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

let activeRequests = 0;
export function apiUnderLoad(): boolean { return activeRequests >= 16 || mediaProcessingActive(); }

export function admissionMiddleware(storage: SharedRateStorage): RequestHandler {
  const active = new Map<string, number>();
  let total = 0;
  let mediaActive = 0;
  return async (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.path === '/health/live' || request.path === '/health/ready') {
      // A public caller must not exhaust a shared quota and make Render's
      // own health probes fail. Readiness coalesces/caches dependency work
      // with a deadline in HealthController; liveness performs no I/O.
      return next();
    }
    const network = clientNetwork(request.ip ?? request.socket.remoteAddress ?? 'unknown');
    const mediaWork = request.method === 'POST' && /^\/api\/v1\/media\/(?:external|uploads\/[^/]+\/complete)\/?$/.test(request.path);
    if (mediaWork && mediaActive >= 3) {
      response.setHeader('Retry-After', '3');
      response.status(503).json({ error: { code: 'IMAGE_PROCESSING_BUSY', message: 'Image processing is busy', details: {} } });
      return;
    }
    if (total >= 64 || (active.get(network) ?? 0) >= 32) {
      response.setHeader('Retry-After', '5');
      response.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable', details: {} } });
      return;
    }
    total++;
    if (mediaWork) mediaActive++;
    activeRequests++;
    active.set(network, (active.get(network) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      total--;
      if (mediaWork) mediaActive--;
      activeRequests--;
      const remaining = (active.get(network) ?? 1) - 1;
      if (remaining) active.set(network, remaining);
      else active.delete(network);
    };
    response.once('finish', release);
    response.once('close', release);
    try {
      const global = await storage.window('admission:global', 6000, 60_000);
      const budget = global.allowed
        ? await storage.window(`admission:network:${network}`, 3000, 60_000)
        : global;
      if (!budget.allowed) {
        response.setHeader('Retry-After', budget.retryAfter);
        response.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests', details: {} } });
        return;
      }
    } catch (error) {
      next(error);
      return;
    }
    next();
  };
}
