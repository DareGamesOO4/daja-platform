import { performance } from 'node:perf_hooks';
import pg, { type QueryResult, type QueryResultRow } from 'pg';
import type { AppConfig } from '@daja/config';
import type { Logger } from '@daja/observability';

export type DbClient = Pick<pg.PoolClient, 'query'>;

export interface Database {
  pool: pg.Pool;
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<T>>;
  close(): Promise<void>;
}

export function databaseConnectionOptions(connectionString: string): Pick<pg.PoolConfig, 'connectionString' | 'ssl'> {
  const databaseUrl = new URL(connectionString);
  const sslMode = databaseUrl.searchParams.get('sslmode')?.toLowerCase();
  const isLocalHost = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(databaseUrl.hostname);
  const needsTls =
    sslMode === 'require' ||
    sslMode === 'verify-ca' ||
    sslMode === 'verify-full' ||
    (!isLocalHost && databaseUrl.hostname.includes('.'));

  // pg reparses SSL URL parameters and can override an explicit ssl object.
  // Do not let sslmode=require silently disable certificate verification.
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) {
    databaseUrl.searchParams.delete(key);
  }
  return { connectionString: databaseUrl.toString(), ssl: needsTls ? { rejectUnauthorized: true } : false };
}

export function createDatabase(config: AppConfig, logger: Logger): Database {
  const pool = new pg.Pool({
    ...databaseConnectionOptions(config.DATABASE_URL),
    max: config.DB_POOL_MAX,
    connectionTimeoutMillis: 5_000,
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: config.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    application_name: 'daja-platform',
    options: '-c search_path=public'
  });

  pool.on('error', (error) => {
    logger.error({ err: error }, 'PostgreSQL pool error');
  });

  const query: Database['query'] = async <T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ) => {
    const start = performance.now();
    try {
      const result = await pool.query<T>(text, values);
      const durationMs = performance.now() - start;
      const logPayload = { durationMs, rowCount: result.rowCount };
      if (durationMs >= config.DB_SLOW_QUERY_MS) {
        logger.warn(logPayload, 'Slow PostgreSQL query');
      } else {
        logger.debug(logPayload, 'PostgreSQL query');
      }
      return result;
    } catch (error) {
      logger.error({ err: error }, 'PostgreSQL query failed');
      throw error;
    }
  };

  return {
    pool,
    query,
    close: () => pool.end()
  };
}
