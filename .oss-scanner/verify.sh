#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

node --version
pnpm --version
test -s apps/server/dist/bin.mjs
test -s apps/server/dist/client/index.html
node apps/server/dist/bin.mjs --version

cd apps/server
node --input-type=module -e 'await import("node-pty"); await import("ffi-rs"); await import("@ff-labs/fff-node");'
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { spawn } from 'node-pty';

await new Promise((resolve, reject) => {
  let output = '';
  const terminal = spawn('/bin/sh', ['-c', 'printf AUDIT_PTY_READY'], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    cols: 80,
    rows: 24,
  });
  const timeout = setTimeout(() => {
    try {
      terminal.kill();
    } finally {
      reject(new Error('PTY smoke check timed out after 10 seconds'));
    }
  }, 10_000);
  terminal.onData((chunk) => { output += chunk; });
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timeout);
    try {
      assert.equal(exitCode, 0, 'PTY shell must exit successfully');
      assert.ok(output.includes('AUDIT_PTY_READY'), 'PTY shell output is missing');
      resolve();
    } catch (error) {
      reject(error);
    }
  });
});
console.log('PTY shell startup, output, and exit verified');
NODE
../../node_modules/.bin/vp test run --maxWorkers=1 \
    src/auth/EnvironmentAuth.test.ts \
    src/auth/RpcAuthorization.test.ts \
    src/auth/SessionStore.test.ts \
    src/auth/ServerSecretStore.test.ts \
    src/auth/dpop.test.ts \
    src/secrets/SecretRequests.test.ts \
    src/assets/AssetAccess.test.ts \
    src/assets/AttachmentUpload.test.ts \
    src/integrations/IntegrationSecretStore.test.ts \
    src/integrations/IntegrationTool.test.ts \
    src/mcp/McpToolAccess.test.ts \
    src/terminal/NodePtyAdapter.test.ts
