// PM2 process file: `pm2 start ecosystem.config.js`
// PORT and WEBHOOK_SECRET still come from .env (server.js reads it itself).
module.exports = {
  apps: [
    {
      name: "sales-celebration",
      script: "server.js",
      cwd: __dirname,
      // One process only: the open screens are kept in memory, so cluster mode
      // would send a win to only the screens connected to one worker.
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      restart_delay: 3000,
      max_memory_restart: "200M",
      time: true,
      env: { NODE_ENV: "production" },
    },
  ],
};
