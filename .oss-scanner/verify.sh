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
