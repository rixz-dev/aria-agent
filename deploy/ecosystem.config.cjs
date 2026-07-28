const { join } = require('node:path');

const root = join(__dirname, '..');

/**
 * PM2 process file untuk menjalankan ketiga service ARIA di VPS:
 *
 *   npm install -g pm2
 *   pm2 start deploy/ecosystem.config.cjs
 *   pm2 save && pm2 startup    # auto-start setelah reboot
 *   pm2 logs aria-orchestrator # tail log
 */
module.exports = {
  apps: [
    {
      name: 'aria-orchestrator',
      cwd: root,
      script: 'apps/orchestrator/src/main.mjs',
      max_memory_restart: '512M',
      restart_delay: 3000,
    },
    {
      name: 'aria-telegram',
      cwd: root,
      script: 'apps/telegram-bot/src/main.mjs',
      max_memory_restart: '256M',
      restart_delay: 3000,
    },
    {
      name: 'aria-whatsapp',
      cwd: root,
      script: 'apps/whatsapp-bot/src/main.mjs',
      max_memory_restart: '512M',
      restart_delay: 5000, // WA kadang perlu jeda lebih panjang saat reconnect
    },
  ],
};
