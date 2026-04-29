/**
 * Seed default rows in the `settings` table so a freshly-bootstrapped DB
 * has explicit, debuggable state instead of relying entirely on code-side
 * defaults. Idempotent — re-running is safe (skips anything already set).
 *
 * Seeds:
 *   1. trading_mode  = 'simulate'   (safe default; flip to 'live' via UI/SQL)
 *   2. coin_configs  = DEFAULT_CONFIG per coin, enabled=false, signal_only
 *   3. telegram_channels = single channel from TELEGRAM_CHANNEL_ID env (if set)
 *
 * Run:
 *   pnpm --filter @trading-bot/api seed-defaults
 *
 * After seeding, edit configs via the dashboard `/settings` page or by
 * UPDATEing rows in `settings` directly.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: true,
});

import { migrate } from '@trading-bot/db/migrate';
import { closePool, getPool } from '@trading-bot/db';
import {
  ALL_COINS, updateCoinConfig, getAllCoinConfigs,
} from '@trading-bot/core/CoinConfig';
import {
  getTelegramChannels, saveTelegramChannels,
} from '@trading-bot/core/telegramChannels';

async function seedTradingMode(): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'trading_mode'`,
  );
  if (rows[0]) {
    console.log(`  ✓ trading_mode already set: "${rows[0].value}" — skip`);
    return;
  }
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO NOTHING`,
    ['trading_mode', 'simulate', Date.now()],
  );
  console.log('  ✓ trading_mode = "simulate" (safe default)');
}

async function seedCoinConfigs(): Promise<void> {
  const existing = await getAllCoinConfigs();
  for (const coin of ALL_COINS) {
    if (existing[coin]) {
      console.log(`  ✓ ${coin.padEnd(5)} : configured (enabled=${existing[coin]!.enabled}, mode=${existing[coin]!.mode}) — skip`);
      continue;
    }
    // Empty patch → updateCoinConfig fills with DEFAULT_CONFIG
    await updateCoinConfig(coin, {});
    console.log(`  ✓ ${coin.padEnd(5)} : seeded defaults (enabled=false, signal_only)`);
  }
}

async function seedTelegramChannel(): Promise<void> {
  const existing = await getTelegramChannels();
  if (existing.length > 0) {
    console.log(`  ✓ telegram_channels: ${existing.length} channel(s) exist — skip`);
    return;
  }
  const envChan = process.env['TELEGRAM_CHANNEL_ID'];
  if (!envChan || envChan === '-100000000000') {
    console.log('  ⚠ TELEGRAM_CHANNEL_ID not set — skipping channel seed');
    console.log('    (Add channels later via /settings page)');
    return;
  }
  await saveTelegramChannels([{
    id:         'default-' + Date.now().toString(36),
    name:       'Default (seeded from env)',
    channel_id: envChan,
    enabled:    true,
    coins:      [],         // [] = all coins
    info_types: [],         // [] = signal + order
  }]);
  console.log(`  ✓ telegram_channels: seeded 1 default channel → ${envChan}`);
}

async function main(): Promise<void> {
  console.log('Running migrations…');
  await migrate();

  console.log('\n── Seeding settings ──────────────────────────────');
  await seedTradingMode();

  console.log('\n── Seeding coin_configs ──────────────────────────');
  await seedCoinConfigs();

  console.log('\n── Seeding telegram_channels ────────────────────');
  await seedTelegramChannel();

  console.log('\n✓ Seed complete. Visit /settings to enable coins + tune.');
}

main()
  .then(() => closePool())
  .catch(err => {
    console.error('Seed failed:', err instanceof Error ? err.message : err);
    closePool().finally(() => process.exit(1));
  });
