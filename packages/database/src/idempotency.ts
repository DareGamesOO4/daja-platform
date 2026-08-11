import { createHash } from 'node:crypto';
import type pg from 'pg';
import { IdempotencyConflictError } from '@daja/security';

export interface IdempotencyResult<T> {
  replayed: boolean;
  status: number;
  payload: T;
}

export class IdempotencyStore {
  constructor(private readonly client: Pick<pg.Pool | pg.PoolClient, 'query'>) {}

  async run<T>(
    organizationId: string,
    key: string,
    requestPayload: unknown,
    handler: () => Promise<{ status: number; payload: T }>
  ): Promise<IdempotencyResult<T>> {
    const requestHash = hashRequest(requestPayload);
    const existing = await this.client.query<{
      request_hash: string;
      status: string;
      response_status: number | null;
      response_payload: T | null;
    }>(
      `SELECT request_hash, status, response_status, response_payload
       FROM idempotency_records
       WHERE organization_id = $1 AND idempotency_key = $2`,
      [organizationId, key]
    );

    if (existing.rowCount === 1) {
      const row = existing.rows[0];
      if (!row || row.request_hash !== requestHash) {
        throw new IdempotencyConflictError();
      }
      if (
        row.status === 'completed' &&
        row.response_status !== null &&
        row.response_payload !== null
      ) {
        return { replayed: true, status: row.response_status, payload: row.response_payload };
      }
    } else {
      await this.client.query(
        `INSERT INTO idempotency_records (organization_id, idempotency_key, request_hash, status)
         VALUES ($1, $2, $3, 'started')`,
        [organizationId, key, requestHash]
      );
    }

    try {
      const response = await handler();
      await this.client.query(
        `UPDATE idempotency_records
         SET status = 'completed', response_status = $3, response_payload = $4
         WHERE organization_id = $1 AND idempotency_key = $2`,
        [organizationId, key, response.status, JSON.stringify(response.payload)]
      );
      return { replayed: false, status: response.status, payload: response.payload };
    } catch (error) {
      await this.client.query(
        `UPDATE idempotency_records
         SET status = 'failed'
         WHERE organization_id = $1 AND idempotency_key = $2`,
        [organizationId, key]
      );
      throw error;
    }
  }
}

function hashRequest(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
