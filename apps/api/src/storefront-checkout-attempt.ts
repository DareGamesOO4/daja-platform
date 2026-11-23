import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { StorefrontRepository, type DbClient } from '@daja/database';
import { AppError, ValidationFailedError } from '@daja/security';

type AttemptCredentials = { attemptHash: string; proofHash: string };
type AttemptRow = {
  proof_hash: string;
  request_hash: string;
  customer_id: string | null;
  order_id: string | null;
  order_customer_id: string | null;
};

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function checkoutCredentials(request: Request): AttemptCredentials {
  const attempt = request.get('Idempotency-Key');
  const proof = request.get('X-Daja-Checkout-Proof');
  if (!attempt || !/^[a-f0-9-]{36}$/i.test(attempt) || !proof || !/^[a-f0-9]{64}$/i.test(proof)) {
    throw new ValidationFailedError('Invalid checkout attempt credentials');
  }
  return { attemptHash: digest(attempt.toLowerCase()), proofHash: digest(proof.toLowerCase()) };
}

export function checkoutRequestHash(secret: string, intent: object): string {
  const serialized = JSON.stringify(intent, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  });
  return createHmac('sha256', secret).update('storefront-checkout:v1:').update(serialized).digest('hex');
}

export class StorefrontCheckoutAttempt {
  constructor(
    private readonly client: DbClient,
    private readonly organizationId: string,
    private readonly credentials: AttemptCredentials,
    private readonly customerId: string | null
  ) {}

  async claim(requestHash: string): Promise<boolean> {
    const result = await this.client.query(
      'INSERT INTO storefront_checkout_attempts (organization_id, attempt_hash, proof_hash, request_hash, customer_id)' +
      ' VALUES ($1, $2, $3, $4, $5) ON CONFLICT (organization_id, attempt_hash) DO NOTHING',
      [this.organizationId, this.credentials.attemptHash, this.credentials.proofHash, requestHash, this.customerId]
    );
    return result.rowCount === 1;
  }

  async finish(orderId: string): Promise<void> {
    await this.client.query(
      'UPDATE storefront_checkout_attempts SET order_id=$3 WHERE organization_id=$1 AND attempt_hash=$2',
      [this.organizationId, this.credentials.attemptHash, orderId]
    );
  }

  async receipt(requestHash?: string) {
    const { rows: [attempt] } = await this.client.query<AttemptRow>(
      'SELECT a.proof_hash, a.request_hash, a.customer_id, a.order_id, o.customer_id AS order_customer_id' +
      ' FROM storefront_checkout_attempts a LEFT JOIN orders o ON o.id=a.order_id AND o.organization_id=a.organization_id' +
      ' WHERE a.organization_id=$1 AND a.attempt_hash=$2',
      [this.organizationId, this.credentials.attemptHash]
    );
    if (!attempt) return null;
    const storedProof = Buffer.from(attempt.proof_hash, 'hex');
    const proof = Buffer.from(this.credentials.proofHash, 'hex');
    if (storedProof.length !== proof.length || !timingSafeEqual(storedProof, proof) ||
        (attempt.customer_id && attempt.customer_id !== this.customerId) ||
        (attempt.order_customer_id && attempt.order_customer_id !== this.customerId)) {
      throw new AppError('CHECKOUT_ATTEMPT_ACCESS_DENIED', 'Checkout attempt access denied', 403);
    }
    if (requestHash !== undefined && attempt.request_hash !== requestHash) {
      throw new AppError('CHECKOUT_ATTEMPT_CONFLICT', 'Checkout attempt already has a different order', 409);
    }
    if (!attempt.order_id) return null;
    const order = await new StorefrontRepository(this.client).getOrder({
      organizationId: this.organizationId,
      orderIdOrDisplayId: attempt.order_id,
      ...(attempt.order_customer_id ? { customerId: attempt.order_customer_id } : { guestOnly: true })
    });
    return { order, guest: !attempt.customer_id && !attempt.order_customer_id };
  }
}
