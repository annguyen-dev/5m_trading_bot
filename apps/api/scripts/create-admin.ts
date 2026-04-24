/**
 * CLI: create a new admin user for the dashboard.
 *
 * Usage:
 *   pnpm --filter @trading-bot/api create-admin <username> <password>
 *
 * Notes:
 *   - Password is bcrypt-hashed before storage; the plaintext never hits the DB.
 *   - Uses the same .env resolution as the main API (monorepo root .env).
 *   - If the username already exists, this reports the error and exits 1.
 *     Use a separate reset-password tool if you want to update the hash.
 *
 * After creating a user, start the dashboard and log in with the credentials.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env from monorepo root (same as server.ts)
dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: true,
});

import { migrate } from '@trading-bot/db/migrate';
import { closePool } from '@trading-bot/db';
import { createAdmin, findAdminByUsername } from '../src/auth/adminRepo.js';

async function main(): Promise<void> {
  const [, , username, password] = process.argv;

  if (!username || !password) {
    console.error('Usage: pnpm --filter @trading-bot/api create-admin <username> <password>');
    process.exit(1);
  }
  if (username.length < 3 || username.length > 64) {
    console.error('Error: username must be 3-64 characters');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Error: password must be at least 8 characters');
    process.exit(1);
  }

  // Ensure the admin_users table exists before inserting.
  await migrate();

  const existing = await findAdminByUsername(username);
  if (existing) {
    console.error(`Error: admin "${username}" already exists (id ${existing.id})`);
    process.exit(1);
  }

  const user = await createAdmin(username, password);
  console.log(`✓ Created admin user`);
  console.log(`  id:       ${user.id}`);
  console.log(`  username: ${user.username}`);
  console.log(`  created:  ${new Date(user.created_at).toISOString()}`);
}

main()
  .then(() => closePool())
  .catch(err => {
    console.error('Fatal:', err instanceof Error ? err.message : err);
    closePool().finally(() => process.exit(1));
  });
