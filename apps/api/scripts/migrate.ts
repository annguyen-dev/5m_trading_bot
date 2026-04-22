import 'dotenv/config';
import { migrate } from '../src/db/migrate.js';
import { closePool } from '../src/db/client.js';

console.log('Running database migrations...');
try {
  await migrate();
} finally {
  await closePool();
}
