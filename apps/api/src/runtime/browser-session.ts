import { createHmac, randomBytes } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs/operators';
import type { AppConfig } from '@daja/config';
import { InvalidTokenError, verifyJwt } from '@daja/security';
import { CONFIG } from '../tokens.js';
import { browserRequest, equalSecret } from './edge-ingress.js';

export const BROWSER_COOKIES = {
  customer: '__Host-daja_customer', refresh: '__Host-daja_refresh',
  staff: '__Host-daja_staff', csrf: '__Host-daja_csrf', oauth: '__Host-daja_oauth'
} as const;

export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header || header.length > 16_384) return undefined;
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  const value = values[0]!.slice(name.length + 1);
  return value.length <= 8192 ? value : undefined;
}

function setCookie(response: Response, name: string, value: string, seconds: number, httpOnly = true): void {
  response.cookie(name, value, { httpOnly, secure: true, sameSite: 'lax', path: '/', maxAge: Math.max(0, seconds) * 1000 });
  response.setHeader('Cache-Control', 'no-store');
}

function staffBinding(token: string, customerToken: string, config: AppConfig): string {
  const customer = verifyJwt(customerToken, config.JWT_ACCESS_SECRET, 'access');
  if (customer.kind !== 'customer' || !customer.fam) throw new InvalidTokenError();
  return createHmac('sha256', config.JWT_ACCESS_SECRET)
    .update(`${customer.org}:${customer.sub}:${String(customer.fam)}:${token}`).digest('hex');
}

export function browserStaffToken(header: string | undefined, config: AppConfig): string | undefined {
  const raw = cookieValue(header, BROWSER_COOKIES.staff);
  const customer = cookieValue(header, BROWSER_COOKIES.customer);
  if (!raw || !customer) return undefined;
  const [token, binding, extra] = raw.split('~');
  if (!token || !binding || extra) return undefined;
  try { return equalSecret(binding, staffBinding(token, customer, config)) ? token : undefined; }
  catch { return undefined; }
}

export function clearBrowserSession(response: Response): void {
  for (const name of Object.values(BROWSER_COOKIES)) setCookie(response, name, '', 0, name !== BROWSER_COOKIES.csrf);
}

export function ensureCsrf(request: Request, response: Response): void {
  if (!cookieValue(request.headers.cookie, BROWSER_COOKIES.csrf)) {
    setCookie(response, BROWSER_COOKIES.csrf, randomBytes(32).toString('hex'), 30 * 86400, false);
  }
}

export function browserSessionMiddleware(config: AppConfig): RequestHandler {
  return (request, response, next) => {
    if (!browserRequest(request)) return next();
    if (!config.BROWSER_SESSIONS_ENABLED) {
      response.status(503).json({ error: { code: 'BROWSER_SESSION_UNAVAILABLE', message: 'Service temporarily unavailable', details: {} } });
      return;
    }
    const safe = ['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (!safe) {
      const origin = request.headers.origin;
      const csrf = cookieValue(request.headers.cookie, BROWSER_COOKIES.csrf);
      if (origin !== new URL(config.STOREFRONT_PUBLIC_BASE_URL).origin || !csrf
        || !equalSecret(request.headers['x-daja-csrf'], csrf)) {
        response.status(403).json({ error: { code: 'CSRF_REQUIRED', message: 'Invalid browser request', details: {} } });
        return;
      }
    }
    // Cookies are authoritative in browser mode. Never combine them with an
    // arbitrary bearer token supplied by the browser's JavaScript.
    delete request.headers.authorization;
    const kind = request.headers['x-daja-session-kind'] === 'staff' ? 'staff' : 'customer';
    const token = kind === 'staff' ? browserStaffToken(request.headers.cookie, config) : cookieValue(request.headers.cookie, BROWSER_COOKIES.customer);
    if (token) request.headers.authorization = `Bearer ${token}`;
    if (request.method === 'POST' && request.path === '/api/v1/customer-auth/refresh') {
      request.body = { refreshToken: cookieValue(request.headers.cookie, BROWSER_COOKIES.refresh) ?? '' };
    }
    if (request.method === 'POST' && request.path === '/api/v1/customer-auth/logout') clearBrowserSession(response);
    next();
  };
}

export function browserSessionStatus(request: Request, response: Response, config: AppConfig) {
  if (!browserRequest(request) || !config.BROWSER_SESSIONS_ENABLED) throw new InvalidTokenError();
  ensureCsrf(request, response);
  const valid = (name: string, type: 'access' | 'refresh') => {
    const token = cookieValue(request.headers.cookie, name);
    try { if (!token) return false; verifyJwt(token, type === 'refresh' ? config.JWT_REFRESH_SECRET : config.JWT_ACCESS_SECRET, type); return true; }
    catch { return false; }
  };
  return {
    browserSessions: true,
    expiresIn: (() => {
      try { return Math.max(0, Number(verifyJwt(cookieValue(request.headers.cookie, BROWSER_COOKIES.customer) ?? '', config.JWT_ACCESS_SECRET, 'access').exp) - Math.floor(Date.now() / 1000)); }
      catch { return 0; }
    })(),
    webSession: valid(BROWSER_COOKIES.customer, 'access') || valid(BROWSER_COOKIES.refresh, 'refresh'),
    staffSession: (() => {
      try { verifyJwt(browserStaffToken(request.headers.cookie, config) ?? '', config.JWT_ACCESS_SECRET, 'access'); return true; }
      catch { return false; }
    })()
  };
}

export function storeBrowserTokens(response: Response, config: AppConfig, data: Record<string, unknown>, staff = false, customerToken?: string): Record<string, unknown> {
  const result = { ...data };
  const access = typeof data.accessToken === 'string' ? data.accessToken : undefined;
  if (access) {
    const payload = verifyJwt(access, config.JWT_ACCESS_SECRET, 'access');
    const value = staff ? `${access}~${staffBinding(access, customerToken ?? '', config)}` : access;
    setCookie(response, staff ? BROWSER_COOKIES.staff : BROWSER_COOKIES.customer, value,
      Math.max(0, Number(payload.exp) - Math.floor(Date.now() / 1000)));
    if (!staff && typeof data.refreshToken === 'string') {
      verifyJwt(data.refreshToken, config.JWT_REFRESH_SECRET, 'refresh');
      setCookie(response, BROWSER_COOKIES.refresh, data.refreshToken, config.REFRESH_TOKEN_TTL_SECONDS);
      // A new customer login must not inherit a different customer's staff role.
      if (data.newLogin !== false) setCookie(response, BROWSER_COOKIES.staff, '', 0);
    }
  }
  for (const field of ['accessToken', 'refreshToken', 'access_token', 'refresh_token', 'tokenType', 'newLogin']) delete result[field];
  return { ...result, ...(staff ? { staffSession: true } : { webSession: true }) };
}

export function beginBrowserOAuth(request: Request, response: Response): string | undefined {
  if (!browserRequest(request)) return undefined;
  const nonce = randomBytes(32).toString('hex');
  setCookie(response, BROWSER_COOKIES.oauth, nonce, 600);
  return nonce;
}

export function validateBrowserOAuth(request: Request, response: Response, nonce: unknown): void {
  if (!browserRequest(request) || !equalSecret(nonce, cookieValue(request.headers.cookie, BROWSER_COOKIES.oauth) ?? '')) throw new InvalidTokenError();
  setCookie(response, BROWSER_COOKIES.oauth, '', 0);
  ensureCsrf(request, response);
}

@Injectable()
export class BrowserSessionInterceptor implements NestInterceptor {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    if (!browserRequest(request)) return next.handle();
    return next.handle().pipe(map((data: unknown) => {
      if (!data || typeof data !== 'object' || Array.isArray(data) || !('accessToken' in data)) return data;
      return storeBrowserTokens(response, this.config, {
        ...data, newLogin: request.path !== '/api/v1/customer-auth/refresh'
      }, request.path === '/api/v1/customer-auth/admin/session', cookieValue(request.headers.cookie, BROWSER_COOKIES.customer));
    }));
  }
}
