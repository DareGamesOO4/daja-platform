import { timingSafeEqual } from 'node:crypto';
import { isIP, type Socket } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Request, RequestHandler } from 'express';
import type { AppConfig } from '@daja/config';

export function equalSecret(first: unknown, second: string): boolean {
  if (typeof first !== 'string' || !second || first.length > 4096) return false;
  const a = Buffer.from(first); const b = Buffer.from(second);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function trustedEdge(request: Pick<IncomingMessage, 'headers'>, secret = process.env.EDGE_SHARED_SECRET ?? ''): boolean {
  return secret.length >= 32 && equalSecret(request.headers['x-daja-edge-key'], secret);
}

export function browserRequest(request: Pick<IncomingMessage, 'headers'>): boolean {
  return trustedEdge(request) && request.headers['x-daja-client'] === 'browser';
}

export function edgeIngress(config: AppConfig): RequestHandler {
  return (request, response, next) => {
    const trusted = trustedEdge(request, config.EDGE_SHARED_SECRET);
    // Google still uses its registered callback URL. Signed OAuth state is
    // checked there, and browser callbacks are forwarded to the same-origin UI.
    const exempt = /^\/health\/(live|ready)\/?$/.test(request.path)
      || (request.method === 'GET' && request.path === '/api/v1/customer-auth/oauth/google/callback');
    if (config.EDGE_ENFORCEMENT === 'enforce' && !trusted && !exempt) {
      response.setHeader('Cache-Control', 'no-store');
      response.status(403).json({ error: { code: 'EDGE_REQUIRED', message: 'Use the protected API endpoint', details: {} } });
      return;
    }
    if (trusted) {
      const ip = request.headers['x-daja-client-ip'];
      if (typeof ip === 'string' && isIP(ip)) Object.defineProperty(request, 'ip', { value: ip, configurable: true });
    } else {
      // Caller-provided identity hints must have no effect outside the gateway.
      for (const name of ['x-daja-client', 'x-daja-client-ip', 'x-daja-session-kind']) delete request.headers[name];
    }
    next();
  };
}

export function allowEdgeUpgrade(request: IncomingMessage): boolean {
  return process.env.EDGE_ENFORCEMENT !== 'enforce' || trustedEdge(request);
}

export function rejectUntrustedUpgrade(request: IncomingMessage, socket: Socket): boolean {
  if (allowEdgeUpgrade(request)) return false;
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  return true;
}
