import 'dotenv/config';
import { loadConfig } from '@daja/config';
import { createLogger } from '@daja/observability';
import { createDatabase } from './pool.js';
import { migrateWhenAvailable, migrationStatus } from './migrations.js';

const command = process.argv[2];
const config = loadConfig();
const logger = createLogger(config, 'database-cli');
// Runtime can use a DML-only role; DDL migrations use a separate credential.
const database = createDatabase({ ...config, DATABASE_URL: config.MIGRATION_DATABASE_URL || config.DATABASE_URL }, logger);

try {
  if (command === 'migrate') {
    const status = await migrateWhenAvailable(database.pool);
    for (const row of status) {
      console.log(`${row.applied ? 'applied' : 'pending'} ${row.version}_${row.name}`);
    }
  } else if (command === 'status') {
    const status = await migrationStatus(database.pool);
    for (const row of status) {
      console.log(`${row.applied ? 'applied' : 'pending'} ${row.version}_${row.name}`);
    }
  } else {
    throw new Error('Usage: tsx packages/database/src/cli.ts <migrate|status>');
  }
} finally {
  await database.close();
}
