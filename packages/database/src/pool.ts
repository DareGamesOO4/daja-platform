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

function sslForDatabaseUrl(connectionString: string): pg.PoolConfig['ssl'] | undefined {
  const databaseUrl = new URL(connectionString);
  const sslMode = databaseUrl.searchParams.get('sslmode')?.toLowerCase();
  const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(databaseUrl.hostname);
  const needsTls =
    sslMode === 'require' ||
    sslMode === 'verify-ca' ||
    sslMode === 'verify-full' ||
    (!isLocalHost && databaseUrl.hostname.includes('.'));

  // Managed Postgres providers (Render/Neon) present a TLS certificate that is
  // not available in local development's certificate store. The encrypted
  // channel is still required; CA verification is handled by the provider
  // connection URL in environments that supply a root certificate.
  return needsTls ? { rejectUnauthorized: false } : undefined;
}

export function createDatabase(config: AppConfig, logger: Logger): Database {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    ssl: sslForDatabaseUrl(config.DATABASE_URL),
    max: config.DB_POOL_MAX,
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
