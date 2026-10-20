# Offline security audit environment

This environment builds the public TritonAI Harness server and web client and
keeps the source, dependencies, source maps, and tests in `/src`. It needs no
provider account, API key, private plugin configuration, or signing credentials.
It is intended for [Anthropic OSS Scanner](https://red.anthropic.com/oss-scanner/)
and local reproduction. Adding these files does not enroll the project.

## Build and verify

Use Docker with BuildKit enabled. Run from a clean checkout of the source revision
to audit:

```sh
docker build -f .oss-scanner/Dockerfile -t tritonai-harness-audit .
docker run --rm --network none tritonai-harness-audit sh .oss-scanner/verify.sh
docker run --rm -it --network none tritonai-harness-audit
```

The Dockerfile-specific ignore file excludes local environment files, runtime
databases, installed dependencies, build output, Git metadata, and the vendored
`.repos/` reference trees. Do not mount a real home directory, credentials, or
the Docker socket into an audit container. The standalone image uses the snapshot
supplied as build context and excludes Git metadata. Anthropic's current
[`tools/check` helper](https://github.com/anthropics/oss-scanner/blob/main/tools/check_build.py)
adds its own analysis tools and Git history in subsequent layers.

Network access is used only to install the pinned toolchain and lockfile
dependencies and populate the existing SPDX license-notice cache. The Dockerfile
runs the application build and verification
steps with `RUN --network=none`; the separate `docker run --network none` command
checks the finished image under the same restriction. Loopback remains usable
for local HTTP and WebSocket test fixtures. No host ports need to be published.

`verify.sh` checks the built CLI, loads its native runtime dependencies, and runs
selected existing server tests covering authentication, session and secret
storage, attachment access, integration tool
policy, MCP authorization, and terminal adaptation. This is an environment smoke
check, not a complete security audit or the full repository test suite. Inside
the image, run further server tests with:

```sh
cd /src/apps/server
../../node_modules/.bin/vp test run --maxWorkers=1 src/auth
```

The server's normal build task also builds and embeds the web client. It leaves
`apps/server/dist/bin.mjs`, `apps/server/dist/client/`, and their source maps
available for reproduction. To inspect CLI options without provider access:

```sh
node /src/apps/server/dist/bin.mjs --help
```

## Coverage limits

- The image exercises Linux and headless JavaScript/TypeScript behavior. It does
  not certify macOS Keychain, Windows credentials/ACLs, native mobile clients,
  Electron GUI behavior, platform permission prompts, or signed update delivery.
- Electron and browser downloads are skipped. Browser automation and native GUI
  tests require a separate environment; their source remains available to read.
- The public build does not include a managed production plugin composition.
  Synthetic integration fixtures exercise the host's authorization boundaries.
  Provider implementation findings belong to the separate Plugins repository.
- No live campus, provider, relay, or third-party service is accessed during
  offline verification. See [the threat model](threat_model.md) for scope.

## Enrollment configuration

When enrollment is separately authorized, the following configuration can be
submitted as `projects/tritonai-harness/project.yaml` in
[`anthropics/oss-scanner`](https://github.com/anthropics/oss-scanner). The paths
must exist on the submitted ref before that enrollment can work:

```yaml
repo: https://github.com/dbalders/TritonAI-Harness#main
primary_contact: tritonai@ucsd.edu
homepage: https://github.com/dbalders/TritonAI-Harness
dockerfile: .oss-scanner/Dockerfile
threat_model: .oss-scanner/threat_model.md
```

Check that configuration with Anthropic's `tools/validate.py`, confirm that
`.github/SECURITY.md` lists the downstream reporting contact, and review the
current program agreement before submitting.
