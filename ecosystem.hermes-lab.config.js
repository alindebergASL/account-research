// PM2 ecosystem for the lab-only Hermes runtime service.
//
// Keep this separate from ecosystem.config.js so production web/worker
// deploys do not accidentally start a runtime process. Use only on the
// isolated lab host while HERMES_RUNTIME_FAKE=1 and localhost binding are
// verified.
const path = require("path");
const WEB_CWD = path.join(__dirname, "web");

module.exports = {
  apps: [
    {
      name: "account-brief-hermes-runtime-lab",
      script: "npm",
      args: "run hermes-runtime",
      cwd: WEB_CWD,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      env: {
        NODE_ENV: "production",
        HERMES_RUNTIME_FAKE: "1",
        HERMES_RUNTIME_BIND_HOST: "127.0.0.1",
        HERMES_RUNTIME_PORT: "8787",
      },
    },
  ],
};
