# syntax=docker/dockerfile:1
FROM node:24.13.1-bookworm@sha256:00e9195ebd49985a6da8921f419978d85dfe354589755192dc090425ce4da2f7

ENV CI=true \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_nodedir=/usr/local

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates git python3 make g++ pkg-config libsecret-1-dev \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --ignore-scripts pnpm@11.10.0

# Anthropic supplies the target repository as the build context.
WORKDIR /src
COPY . /src

RUN pnpm install --frozen-lockfile --child-concurrency=1 --network-concurrency=8 \
    && rm -rf /root/.local/share/pnpm/store /root/.npm/_cacache
RUN node scripts/sync-third-party-license-notices.ts
RUN --network=none pnpm exec vp run --filter t3 build

# Exercise installed dependencies and the built CLI with the build network removed.
RUN --network=none sh .oss-scanner/verify.sh

CMD ["/bin/bash"]
