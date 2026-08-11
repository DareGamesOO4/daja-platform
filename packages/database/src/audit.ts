import type pg from 'pg';
import type { RequestContext } from '@daja/shared';

export class AuditRepository {
  constructor(private readonly client: Pick<pg.Pool | pg.PoolClient, 'query'>) {}

  async append(input: {
    ctx: RequestContext;
    aggregateType: string;
    aggregateId: string;
    operation: string;
    beforePayload?: unknown;
    afterPayload?: unknown;
    reason?: string;
  }): Promise<string> {
    const result = await this.client.query<{ id: string }>(
      `INSERT INTO audit_events (
         organization_id, location_id, actor_user_id, device_id, aggregate_type, aggregate_id,
         operation, before_payload, after_payload, reason, correlation_id, request_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        input.ctx.organizationId,
        input.ctx.locationId ?? null,
        input.ctx.userId,
        input.ctx.deviceId ?? null,
        input.aggregateType,
        input.aggregateId,
        input.operation,
        input.beforePayload === undefined ? null : JSON.stringify(input.beforePayload),
        input.afterPayload === undefined ? null : JSON.stringify(input.afterPayload),
        input.reason ?? null,
        input.ctx.correlationId,
        input.ctx.requestId
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Audit insert did not return an id');
    }
    return row.id;
  }
}
