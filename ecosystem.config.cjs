/**
 * PM2 ecosystem — production process manager config.
 *
 * Usage:
 *   npm run start          # start all processes
 *   npm run stop           # stop all processes
 *   npm run logs           # tail logs
 *   pm2 restart trading-api
 *   pm2 status
 *
 * Prerequisites:
 *   npm run build          # build backend + fe first
 *   cd infra && docker compose up -d   # start postgres + grafana-agent
 */
'use strict';

module.exports = {
  apps: [
    {
      name: 'trading-api',
      script: './backend/dist/api/server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        FRONTEND_DIST: './fe/dist',
      },
      error_file: './logs/api-error.log',
      out_file: './logs/api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      restart_delay: 3000,
      max_restarts: 10,
    },
    {
      name: 'trading-bot',
      script: './backend/dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/bot-error.log',
      out_file: './logs/bot-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      restart_delay: 5000,
      max_restarts: 10,
    },
  ],
};
