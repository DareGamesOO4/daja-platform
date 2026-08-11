import 'dotenv/config';
import { loadConfig } from '@daja/config';
import { createLogger } from '@daja/observability';
import { createDatabase } from './pool.js';
import { migrate, migrationStatus } from './migrations.js';

const command = process.argv[2];
const config = loadConfig();
const logger = createLogger(config, 'database-cli');
const database = createDatabase(config, logger);

try {
  if (command === 'migrate') {
    const status = await migrate(database.pool);
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
