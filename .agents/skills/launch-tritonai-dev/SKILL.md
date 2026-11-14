---
name: launch-tritonai-dev
description: Run this checkout's isolated Harness Electron desktop and inspect or stop its owned instance.
---

Use the installed `launch-tritonai-dev/scripts/launch.sh` wrapper with this checkout selected by `TRITONAI_HARNESS_REPO`. It routes to `scripts/launch.mjs` beside this skill. Commands are `start` (default), `status`, `stop`, `restart`, and `--check-checkout`.

Each checkout uses `.t3/desktop` for server state and `.t3/desktop/electron` for Electron app data. Supply existing authorized credentials through the environment without printing them. Keep the Node version required by this checkout’s package.json and Vite Plus on PATH. The launcher reports its exact profile, backend descriptor and debugging URL; read the dev-runner output for selected ports. Retain the launch terminal.

Verify the running desktop from this checkout, including the interaction under test. A browser preview, a build or a health check does not establish desktop behavior. Use the repository's test-t3-app and test-t3-mobile procedures for those surfaces.

Stop only this checkout through `stop` or its retained launch terminal. Ownership checks refuse a reused PID or a different checkout. Never remove another checkout's records, stop its app or reuse its profile. An assistant turn ending is not teardown.
