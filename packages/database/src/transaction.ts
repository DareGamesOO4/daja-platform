import type pg from 'pg';
import type { Logger } from '@daja/observability';

export class TransactionManager {
  constructor(
    private readonly pool: pg.Pool,
    private readonly logger: Logger
  ) {}

  async run<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      committed = true;
      return result;
    } catch (error) {
      if (!committed) {
        await client.query('ROLLBACK').catch((rollbackError) => {
          this.logger.error({ err: rollbackError }, 'Transaction rollback failed');
        });
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
