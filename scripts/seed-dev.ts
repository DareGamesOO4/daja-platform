import 'dotenv/config';
import { loadConfig } from '@daja/config';

const config = loadConfig();

if (config.NODE_ENV === 'production') {
  throw new Error('Development seed is blocked in production');
}

console.log('No development seed data is required for Plan 1.');
