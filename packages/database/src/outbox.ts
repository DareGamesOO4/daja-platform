import type pg from 'pg';
import type { RequestContext } from '@daja/shared';

export class OutboxRepository {
  constructor(private readonly client: Pick<pg.Pool | pg.PoolClient, 'query'>) {}

  async append(input: {
    ctx: Pick<RequestContext, 'organizationId'>;
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  }): Promise<string> {
    const result = await this.client.query<{ id: string }>(
      `INSERT INTO domain_outbox (organization_id, event_type, aggregate_type, aggregate_id, payload)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        input.ctx.organizationId,
        input.eventType,
        input.aggregateType,
        input.aggregateId,
        JSON.stringify(input.payload)
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Outbox insert did not return an id');
    }
    return row.id;
  }
}
