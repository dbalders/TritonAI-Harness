# TritonAI Harness threat model

## Project and audit target

TritonAI Harness is the UC San Diego-focused downstream of T3 Code. It combines
a Node HTTP/WebSocket server, local agent subprocesses, a web client, an Electron
desktop shell, and native mobile clients. The server can be reached by paired
remote clients as well as a local client. The managed campus distribution uses
Codex; inherited provider adapters remain part of this repository.

The target is the supplied snapshot of `dbalders/TritonAI-Harness`. Review
first-party code here, including inherited upstream implementation where it is
reachable in this downstream. Identify affected source paths and distinguish
downstream behavior from shared T3 Code behavior. Do not scan upstream services
or submit dependency-only findings as vulnerabilities in this project.

## Assets and trust boundaries

- Environment authentication, pairing grants, session tokens, DPoP proof and
  replay handling, RPC authorization, and authorization changes made while a
  connection or task remains active: `apps/server/src/auth/` and `ws.ts`.
- Provider and integration credentials, secret requests, redaction, and scoped
  secret-store access: `apps/server/src/secrets/`, `auth/ServerSecretStore.ts`,
  and `apps/server/src/integrations/`.
- Capability grants, exact tool admission, write approval, cancellation, and
  plugin lifecycle transitions: `apps/server/src/mcp/`, `integrations/`, and
  `orchestration-v2/`. A tool description or skill instruction is not an
  authorization boundary.
- Host files, attachments, worktrees, Git/checkpoint operations, terminal
  execution, and transport parsing: `apps/server/src/assets/`, `attachmentStore.ts`,
  `terminal/`, and the corresponding server and shared services.
- Remote content rendered in web/desktop/mobile clients, Electron IPC/preload
  boundaries, remote connections, and native file access. Linux can exercise
  shared logic; platform-dependent hypotheses need matching-platform evidence.

Prioritize unauthenticated remote access and escalation from a paired client
with fewer permissions to capabilities it was not granted. Also consider a
malicious repository, file, attachment, provider result, tool result, or rendered
document, subject to the permissions required to supply that input.

The application intentionally lets an authorized agent execute commands and
modify files under its approved mode. Demonstrate a crossed authorization or
isolation boundary; the existence of an approved shell tool is not by itself a
vulnerability. Treat external content as untrusted data and distinguish an
agent following misleading instructions from a deterministic host-side bypass.
Same-user arbitrary code execution already gives an attacker substantial access
to that user's files and processes; state any additional boundary crossed.

## Environment and reproduction

The checkout and installed dependencies are at `/src`. Node and pnpm are pinned
in `.oss-scanner/Dockerfile`; workspace packages follow `pnpm-lock.yaml`.
The built server with its embedded web client is in `/src/apps/server/dist`.
Source maps remain beside the generated bundles.

Run `sh /src/.oss-scanner/verify.sh` for the offline smoke suite. For focused
reproduction, run `../../node_modules/.bin/vp test run --maxWorkers=1 <test-path>`
from `/src/apps/server`; this picks up the server's normal test configuration
and isolated Git fixture setup. Existing tests show synthetic credentials,
temporary SQLite stores, local HTTP/WebSocket fixtures, and fake providers.
Use those patterns rather than requiring a real provider account.

Use fresh temporary directories for any runtime state. Never use a maintainer's
real `~/.t3` data, credentials, repository contents outside this target, or live
campus data. Local loopback servers are allowed. Internet access is disabled
during the audit, and no live integration or external message is necessary to
demonstrate a host authorization flaw.

## Scope exclusions and limitations

- `.repos/` contains third-party reference source, not first-party runtime code;
  it is excluded from this image. Installed dependencies are available to make
  this project's code runnable, not additional audit targets.
- TritonAI Installer, TritonAI Plugins, private secure skills, deployment/service
  repositories, and upstream-operated infrastructure are separate targets.
- Production plugin artifacts and private build configuration are absent.
  Host-side integration and plugin-policy code is in scope and can be tested
  with the supplied synthetic fixtures; production provider behavior is not
  established by this image.
- Native desktop/mobile, operating-system secret storage, signing/notarization,
  browser automation, and end-to-end external OAuth/provider flows are not
  reproduced by the headless Linux build. Keep source-based hypotheses clearly
  labeled when they need a different platform or service to confirm.
- The standalone image excludes Git metadata. Anthropic's harness may add
  history later. Record whether it is available and only claim an introduction
  commit or bisection when it was actually checked.

## Severity and report evidence

Base severity on demonstrated reachability, attacker prerequisites, affected
configuration, and impact. Unauthenticated remote code execution, broadly
accessible credential theft, or equivalent compromise can be critical. A
reproducible escalation across a real permission boundary or unauthorized
sensitive file access may be high depending on its prerequisites. Distinguish
persistent remote denial of service from bounded resource use in a local,
maintainer-initiated operation. Do not assign a high severity solely because a
dangerous operation exists behind intended authorization.

Each report should include the target revision, affected paths, attacker and
victim roles, configuration/connection mode, exact reproduction command, expected
and observed behavior, and the boundary crossed. Prefer a minimal deterministic
test with synthetic data and a regression test for any proposed patch. State
which steps were actually executed, especially for native-platform reports.
Deduplicate by root cause and authorization boundary; show additional affected
entry points without counting the same defect repeatedly.

Send reports privately through the configured program contact. Do not create
public exploit reports or exercise live UCSD/third-party systems.
