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
    let connectionError: Error | undefined;
    const onConnectionError = (error: Error) => { connectionError = error; };
    client.on('error', onConnectionError);
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      if (connectionError) throw connectionError;
      await client.query('COMMIT');
      committed = true;
      return result;
    } catch (error) {
      if (!committed && !connectionError) {
        await client.query('ROLLBACK').catch((rollbackError) => {
          connectionError = rollbackError instanceof Error ? rollbackError : new Error('Rollback failed');
          this.logger.error({ err: rollbackError }, 'Transaction rollback failed');
        });
      }
      throw error;
    } finally {
      client.release(connectionError);
      client.removeListener('error', onConnectionError);
    }
  }
}
