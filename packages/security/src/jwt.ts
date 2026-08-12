import { createHmac, timingSafeEqual } from 'node:crypto';
import { InvalidTokenError } from './index.js';

export interface JwtPayload {
  sub: string;
  org: string;
  typ: 'access' | 'refresh';
  jti: string;
  fam?: string;
  dev?: string;
  iat?: number;
  exp?: number;
  [key: string]: unknown;
}

export function signJwt(payload: JwtPayload, secret: string, ttlSeconds: number): string {
  assertSecret(secret);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = {
    ...payload,
    iat: now,
    exp: now + ttlSeconds
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedBody = base64UrlEncode(JSON.stringify(body));
  const signature = sign(`${encodedHeader}.${encodedBody}`, secret);
  return `${encodedHeader}.${encodedBody}.${signature}`;
}

export function verifyJwt(
  token: string,
  secret: string,
  expectedType: JwtPayload['typ']
): JwtPayload {
  assertSecret(secret);
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new InvalidTokenError();
  }
  const [encodedHeader, encodedBody, signature] = parts as [string, string, string];
  const expected = sign(`${encodedHeader}.${encodedBody}`, secret);
  if (!constantTimeEqual(signature, expected)) {
    throw new InvalidTokenError();
  }
  const header = parseJson<Record<string, unknown>>(encodedHeader);
  if (header.alg !== 'HS256' || header.typ !== 'JWT') {
    throw new InvalidTokenError();
  }
  const payload = parseJson<JwtPayload>(encodedBody);
  if (payload.typ !== expectedType || !payload.sub || !payload.org || !payload.jti) {
    throw new InvalidTokenError();
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) {
    throw new InvalidTokenError('Authentication token has expired');
  }
  return payload;
}

export function sha256Hex(value: string): string {
  return createHmac('sha256', 'daja-auth-token-hash').update(value).digest('hex');
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseJson<T>(encoded: string): T {
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T;
  } catch {
    throw new InvalidTokenError();
  }
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function assertSecret(secret: string): void {
  if (secret.length < 32) {
    throw new InvalidTokenError('JWT secret must be configured with at least 32 characters');
  }
}
