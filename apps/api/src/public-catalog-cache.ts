import { createHash } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';

const FRESH_MS = 30_000;
type Value = object;
type Entry<T extends Value = Value> = {
  value: T;
  etag: string;
  generatedAt: number;
  freshUntil: number;
  staleUntil: number;
};

const memory = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
let activeReads = 0;

export const productCacheKey = (organizationId: string, slug: string) => `catalog:slug:public-v5:${organizationId}:${slug}`;
export const productCacheEpoch = (organizationId: string) => `catalog:public-epoch:${organizationId}`;

export function invalidatePublicCatalogCache(organizationId: string) {
  for (const key of memory.keys()) if (key.startsWith(`${organizationId}:`)) memory.delete(key);
  for (const key of inflight.keys()) if (key.startsWith(`${organizationId}:`)) inflight.delete(key);
}

export function readPublicCatalog<T>(key: string, load: (current: () => boolean) => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  if (activeReads >= 12) throw new ServiceUnavailableException('Catalog temporarily busy');
  activeReads++;
  const request: Promise<T> = Promise.resolve().then(() => load(() => inflight.get(key) === request)).finally(() => {
    activeReads--;
    if (inflight.get(key) === request) inflight.delete(key);
  });
  inflight.set(key, request);
  return request;
}

export function catalogEntry<T extends Value>(value: T, generatedAt: number, ttl = FRESH_MS): Entry<T> {
  const boundary = (input: unknown): number => {
    if (!input || typeof input !== 'object') return Infinity;
    if (Array.isArray(input)) return input.reduce((end, item) => Math.min(end, boundary(item)), Infinity);
    const item = input as Record<string, unknown>;
    const times = [item.saleValidUntil, item.nextSaleStartsAt]
      .map(date => typeof date === 'string' ? Date.parse(date) : NaN).filter(Number.isFinite);
    return Math.min(...times, boundary(item.items), boundary(item.groups));
  };
  return {
    value, generatedAt, freshUntil: Math.min(generatedAt + ttl, boundary(value)),
    staleUntil: generatedAt + 300_000,
    etag: `W/"catalog-${createHash('sha256').update(JSON.stringify(value)).digest('base64url')}"`,
  };
}

export function bypassCatalogCache(request: Request) {
  return request.get('X-Daja-Catalog-Refresh') === '1';
}

export function replyCatalog<T extends Value>(request: Request, response: Response, entry: Entry<T>, source: string, started: number) {
  const { value, ...metadata } = entry;
  response.setHeader('Cache-Control', 'no-store');
  if (entry.freshUntil > Date.now()) response.setHeader('ETag', entry.etag);
  response.setHeader('X-Daja-Catalog-Cache', JSON.stringify(metadata));
  response.setHeader('Server-Timing', `catalog;dur=${(performance.now() - started).toFixed(1)}, catalog_cache;desc="${source}"`);
  if (entry.freshUntil > Date.now() && request.get('If-None-Match')?.split(',').some(tag =>
    tag.trim() === '*' || tag.trim().replace(/^W\//, '') === entry.etag.replace(/^W\//, ''))) {
    response.status(304);
    return undefined;
  }
  return Array.isArray(value) ? value : { ...value, _catalogCache: metadata };
}

export async function publicCatalogResponse<T extends Value>(
  enabled: boolean, request: Request, response: Response, key: string, load: () => Promise<T>, ttl = FRESH_MS
) {
  if (!enabled) return load();
  const started = performance.now();
  const force = bypassCatalogCache(request);
  const cached = memory.get(key);
  if (!force && cached && cached.freshUntil > Date.now())
    return replyCatalog(request, response, cached as Entry<T>, 'memory', started);
  const entry = await readPublicCatalog(key + (force ? ':refresh' : ''), async current => {
    const confirmedAt = Date.now();
    const result = catalogEntry(await load(), confirmedAt, ttl);
    if (current() && result.freshUntil > Date.now() &&
        (memory.get(key)?.generatedAt ?? 0) <= result.generatedAt) {
      memory.delete(key);
      memory.set(key, result);
      if (memory.size > 96) memory.delete(memory.keys().next().value!);
    }
    return result;
  });
  return replyCatalog(request, response, entry, 'database', started);
}
