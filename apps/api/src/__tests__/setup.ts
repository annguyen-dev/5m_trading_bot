// Global test setup — runs before every test file.
// Sets the minimum env vars required by config/index.ts so that
// modules don't throw at import time.
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
process.env.VOYAGE_API_KEY = 'test-voyage-key';
process.env.TELEGRAM_TOKEN = '123456789:AAFtest';
process.env.TELEGRAM_CHANNEL_ID = '-100123456789';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
