---
name: launch-tritonai-dev
description: Launch, inspect, test, or stop an isolated TritonAI Harness Electron development instance for a PR. Use separate worktrees to run multiple dev desktops concurrently on macOS or Linux.
---

# Launch an isolated Harness dev instance

Use this checkout's launcher so its implementation matches the code under test. Select the intended PR worktree explicitly; for general development, fetch origin and create a worktree from current `origin/main`. Check its branch, commit and working changes. Use Node 24 as required by `package.json`; install dependencies with `vp i` if needed. Loading a managed gateway environment may replace PATH with its Node 22 runtime: retain the development Node directory at the front of PATH. Never update another task's checkout or stop an app identified only by its name.

Each checkout owns one retained dev runner. Different worktrees can run simultaneously. A second launch in the same checkout returns the existing instance instead of replacing it. Builds and Electron bundles are checkout-local, so use another worktree for a second instance of the same branch.

On memory-constrained hosts, run repository-wide checks and cold builds one at a time, then keep the ready instances running together. Reduce concurrency before retrying after heavy swapping, renderer resource errors or load-related test timeouts.

## Launch and identify

Run in a retained terminal:

```sh
TRITONAI_HARNESS_REPO=/absolute/pr-worktree /absolute/pr-worktree/.agents/skills/launch-tritonai-dev/scripts/launch.sh
```

The launcher selects its own `.t3/launch-tritonai-dev/home`, Electron profile and debugging port. The dev runner selects available backend/renderer ports. Fresh managed Codex homes follow this isolated app home. Existing settings can explicitly override provider homes; inspect them before using provider tests. Never seed an instance by linking live databases or provider homes. Load an authorized gateway environment without printing credentials when the test requires a provider.

Wait for **renderer ready** and **ready**. The probe checks React mounting, IndexedDB and authentication to the window's backend; failed readiness stops the owned launch. Read `launch.log` when setup fails. Build or listening messages alone do not prove a usable window.

```sh
TRITONAI_HARNESS_REPO=/absolute/pr-worktree /absolute/pr-worktree/.agents/skills/launch-tritonai-dev/scripts/launch.sh status
```

The private `.t3/launch-tritonai-dev/instance.json` records checkout, branch, commit, initial dirty flag, start time, supervisor/runner PIDs, home, Electron profile, debugging endpoint and renderer/backend URLs. The native window title includes the worktree and initial commit. The receipt is initial launch evidence: rebuilds, checkout changes and settings changes require fresh verification. A status with `ownerAlive: false` is historical, even if its last readiness check passed.

## Open and test this instance

Identify this window by its instance title and the receipt’s exact `appBundleId` or `appBundlePath`, never a shared display name. Each checkout has a stable native app identity; commits change the window label, not that identity. macOS may request Keychain approval during startup; handle that through the user when the runtime cannot interact with the OS prompt. Never disable credential encryption to make a test pass. Use the runtime's available native app controls for desktop interaction. When an advertised desktop/CDP control supports attachment, use the receipt's exact `debugUrl`; this addresses the actual Electron profile. The debug endpoint is local maintainer access and should not be exposed remotely.

Development protocol links still use the OS-wide `t3code-dev` handler, which the most recently registered checkout may own. Open the recorded app identity when selecting a test window; when testing browser-to-app authentication, verify which instance receives the callback.

For browser-only behavior, use the product-native collaborative preview and the Vite URL from this launch's log. That browser has its own storage/authentication and is not proof of the Electron window. Do not invent an attachment tool or bypass the runtime's supported browser controls.

To recheck the actual desktop after a rebuild, use:

```sh
node /absolute/pr-worktree/.agents/skills/launch-tritonai-dev/scripts/ensure-renderer.mjs --repo /absolute/pr-worktree --port DEBUG_PORT
```

Drive the changed user interaction and inspect the result. Read the backend's `/.well-known/t3/environment` and relevant provider status from this instance, using the backend URL in the receipt. Healthy launch is prerequisite evidence, not feature verification. Follow the installed pstack Citizen Developer verification protocol when applicable.

Plugins still require the checkout's build-time composition: `TRITONAI_PLUGIN_COMPOSITION_SOURCE`, `TRITONAI_PLUGIN_CONFIGURATION_JSON` and a task-owned `TRITONAI_PLUGIN_BOOT_REPORT_PATH`. Select pinned compatible development artifacts, verify expected plugin IDs in the boot report, and demonstrate the relevant tool when testing integrations. An empty development composition cannot verify a plugin feature.

## Stop or restart

Use the same checkout selection:

```sh
TRITONAI_HARNESS_REPO=/absolute/pr-worktree /absolute/pr-worktree/.agents/skills/launch-tritonai-dev/scripts/launch.sh stop
TRITONAI_HARNESS_REPO=/absolute/pr-worktree /absolute/pr-worktree/.agents/skills/launch-tritonai-dev/scripts/launch.sh restart
```

Stop addresses the recorded supervisor only after checking its process start identity. The supervisor stops its captured process group. No process-name search or global dev shutdown is used. Stale ownership with a surviving group is an inspection error, never permission to kill by pattern. Keep the instance running through the test/review loop; stop it when testing finishes unless it is being left for David to inspect.

Stopping preserves logs and instance state for another test. Delete only this task's isolated home when a fresh fixture is required, after confirming the instance stopped. Other worktrees, Stable and Nightly remain independent.

`launch.sh --check-checkout` reports the selected revision without starting an app. The launcher currently uses POSIX process groups; Windows desktop profile isolation is implemented in the application, but this launcher is not a Windows process manager.
