// PM2 ecosystem for AccountBriefBuilder.
//
// Two apps share the same SQLite DB and the same web/.env.local:
//
//   - account-brief         : Next.js web. Worker disabled.
//   - account-brief-worker  : research queue worker. Singleton, fork mode.
//
// Both apps cwd into the web/ directory so:
//   - the worker's loadEnvConfig(process.cwd()) finds .env.local
//   - SQLite path resolution (web/data/briefs.sqlite) matches across procs
//   - npm run start / npm run worker resolve correctly
//
// Deploy ordering (see plan):
//   pm2 startOrReload ecosystem.config.js --only account-brief-worker --update-env
//   pm2 startOrReload ecosystem.config.js --only account-brief --update-env
//   pm2 save

const path = require("path");
const WEB_CWD = path.join(__dirname, "web");

module.exports = {
  apps: [
    {
      name: "account-brief",
      script: "npm",
      // Explicit host+port so we never accidentally bind 0.0.0.0.
      args: "run start -- -H 127.0.0.1 -p 3000",
      cwd: WEB_CWD,
      instances: 1,
      autorestart: true,
      env: {
        NODE_ENV: "production",
        RESEARCH_WORKER_ENABLED: "false",
      },
    },
    {
      name: "account-brief-worker",
      script: "npm",
      args: "run worker",
      cwd: WEB_CWD,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      env: {
        NODE_ENV: "production",
        RESEARCH_WORKER_ENABLED: "true",
      },
    },
  ],
};
