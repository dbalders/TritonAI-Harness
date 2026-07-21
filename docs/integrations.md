# Plugin foundation

TritonAI Harness plugins are versioned, included packages that can bundle Codex skills and a
host-supplied service backend. The Harness build defines the available catalog; users do not add a
marketplace or install arbitrary packages. In Settings → Plugins, they can turn each included plugin
on or off and choose the user-facing abilities exposed by that plugin under **Access**.

This architecture lane intentionally includes no production plugins. Development fixtures prove the
same host supports both a skills-only package and a credential-backed package with tools; production
connectors live in their own plugin repositories and consume this contract.

## Package contract

Every package contains `.tritonai-plugin/plugin.json` with:

- `apiVersion: tritonai.harness/v2`, `kind: IntegrationPlugin`, and `manifestVersion: 2`;
- a stable package ID and semantic version;
- an optional provider ID;
- fixed capabilities and the tools and skills associated with each capability.

Capabilities are user-facing ability bundles and the single source of truth for skill and tool
availability. Each capability declares `access: "default" | "opt-in"`. Tools and skills declare
their dependencies with `capabilities`. Multiple references use union semantics, so a shared
dependency remains available while any enabled, granted capability requires it. A skills-only
package omits `provider` and declares no tools.

Every tool also declares `effect: "read" | "write"`, which must agree with the provider's executable
metadata. Write tools follow the task's selected runtime mode: supervised modes request approval,
while Full access preauthorizes them.

The Harness-specific manifest name is intentional. These packages are curated, server-executed
Harness components rather than user-installable Codex marketplace plugins. Their `skills/`
directories use the normal Codex `SKILL.md` contract, while the Harness manifest adds the
provider, capability, and tool allowlist needed for host-side enforcement. If
portable Codex plugin ingestion is added later, it should be an explicit adapter rather than
treating arbitrary Codex MCP or app configuration as trusted Harness backend code.

Manifest v1 deliberately permits at most one host provider per package while allowing many
capabilities, skills, and narrow tools. Read and write abilities can share that connection while
remaining separate capability and executable surfaces. A separate plugin remains appropriate when
the provider genuinely requires a different security principal or credential boundary.

The registry rejects malformed manifests, unsupported v1 fields, unknown capability references,
duplicate names within the tool or skill namespace, duplicate provider tools, provider/manifest
mismatches, partial connection lifecycles, competing package sources,
unsafe package paths, symlinks, special files, malformed skill frontmatter, and staged manifests
that differ from discovery.
Bundled `SKILL.md` frontmatter is parsed as YAML through the same schema path used by Codex skill
installation; it must contain a nonempty matching `name` and a nonempty `description` no longer
than Codex's 1,024-character limit.

The current Harness build is canonical for included package contents and versions. At startup, the
registry transactionally reconciles installed included packages with their current build copies
while preserving enablement and capability selections. It repairs both version changes and
same-version asset drift, and removes crash-orphaned package trees that were never committed to
state. Packages no longer included by the build have no runtime surface and their managed Codex
skills are pruned; their state and files are retained until an explicit, provider-aware retirement
migration can also remove credentials safely. This is bundled-package reconciliation, not a network
marketplace or arbitrary package update mechanism. The build must assemble the complete catalog
before registry construction; post-start package discovery and registration are intentionally not
supported.

## Provider and security boundary

Provider-specific behavior implements `IntegrationProvider` in `IntegrationRegistry.ts`. Every
provider owns readiness status and tool invocation. An authenticated provider additionally
implements `connect` and `disconnect` as one complete lifecycle; device-code providers also
implement `poll`, while API-key providers complete through a typed submission to `connect`. A
stateless tool provider omits the lifecycle methods. Generic RPC, MCP, Codex, and Plugins UI code
operate on provider-neutral summaries and lifecycle operations, so skill-only, stateless-tool, and
authenticated packages do not require provider-specific host branches.

Each provider tool truthfully declares whether it is read-only, destructive, idempotent, and
open-world. Harness uses that metadata to publish truthful MCP annotations. Write tools are
supported; they are not rejected merely because they can modify data.

An authenticated MCP provider session receives one coarse `integrations.invoke` transport scope.
It lets the session enter the integration subsystem, and its credential does not need to be reissued
when an included plugin is toggled. It is not a user permission, package access level, approval
boundary, or read/write policy. Preview-only or future limited MCP credentials can omit it entirely.

A tool declares one executable Effect input schema. Harness derives the MCP and Codex JSON Schema
from it, requires an object-shaped contract, and decodes with exact-property checking before calling
provider code. The advertised and enforced contracts therefore cannot drift.

Those metadata fields and skill instructions are not the provider's authorization boundary. The
real boundary is the combination of:

- the plugin being installed and enabled;
- the provider reporting the capability required by the manifest tool, after connection when that
  provider has an authorization lifecycle;
- a specific, allowlisted provider tool implementation;
- the task's selected runtime mode;
- the server-side credential's scopes and the remote service's own enforcement.

OAuth scope presence is necessary but not sufficient. The registry independently checks the user's
selected Harness capabilities, so additive or previously consented provider scopes cannot widen the
tool surface. A skill saying "read-only" is guidance, not a substitute for capability selection,
narrow provider tools, invocation-time checks, and runtime approval.

Credentials remain behind the server secret-store boundary. Each included provider receives a
facade that accepts only local secret suffixes and constructs a collision-free namespace from the
package ID, preventing prefix-overlapping package IDs from reading, writing, or deleting each
other's secrets. Host-declared exact aliases preserve only known legacy credential names during
migration. Credentials do not enter persisted browser state, settings JSON, logs, skills, chat,
connection RPC results, or tool results. API-key entry exists only in the local form and
authenticated request long enough to submit it to the server secret boundary. Provider exceptions
are private by default; only deliberately sanitized `IntegrationProviderPublicError` messages may
cross the client boundary. Tool
results are JSON-normalized and fail closed when they cannot be serialized.

## Connection flows

Connection results are discriminated by `kind`. The current contract and UI implement
`kind: "device_code"`, with a verification URL, user code, expiry, and polling interval, and
`kind: "api_key"`, with an opaque, length-bounded submission that goes directly to the provider's
server-side commit boundary. A successful API-key submission returns `kind: "connected"`; the key
is never included in a result. Redirect or other connection experiences must extend the union with
their own secure submission contract and rendering instead of pretending to use another flow's
fields or adding ambiguous optional fields.

Connecting requests only the plugin's enabled capabilities. Enabling an ability whose provider
grant is missing starts the same explicit authorization flow; the ability remains unavailable until
both selection persistence and provider authorization succeed. Device-code polling and API-key
submission are keyed by plugin and flow ID and cannot overwrite another plugin's flow state;
polling also honors provider retry delays and expiry.

## Lifecycle

Installation stages a complete package, validates it, atomically publishes the versioned copy, and
then persists enablement. Installed state, plugin enablement, and capability selections survive
restart. Existing v1 state without a capability selection migrates to only the manifest's default
abilities; opt-in abilities never become active from provider scopes alone.

Disable, disconnect, and internal removal immediately revoke new tool and skill admission, abort
active tool work, and wait for its cleanup before their serialized lifecycle mutation runs. If tool
work does not drain within the revocation deadline, the provider is faulted and credential or state
mutation does not begin. Disconnect preserves the installed package and its
preferences. Removal remains a migration/recovery primitive rather than a public RPC in the fixed
catalog product. It first disconnects the provider, records a durable recovery phase, moves the
package to a tombstone, commits removed state, and then cleans the tombstone. Startup completes
interrupted removals deterministically.

Provider status checks have a host timeout and receive an abort signal, so one unhealthy provider
cannot block startup, listing, or task creation indefinitely. Providers may implement `prepare` to
restore ephemeral invocation state, such as an OAuth access token, from persisted credentials. The
Harness coalesces concurrent preparation, journals any admitted credential commit, and runs it before
tool status and invocation checks. MCP and Codex task cancellation is propagated through Registry to
provider work. Connection lifecycle work is bounded and abortable.
Immediately before its final external commit, a provider must await `beginCommit()`. The host first
writes a durable commit journal and rechecks cancellation, then admits only the provider's narrow,
internally bounded commit tail under a fresh watchdog. Admission returns a commit-tail signal that
aborts shortly before the watchdog, and providers must pass it to fallible storage or network work
so mutations stop before the host reports a timeout. Cancellation or timeout before admission wins.
Only a settled success clears the journal. Any provider rejection, crash, or watchdog expiry leaves
it in place, so both the current process and the next start fail closed rather than trusting a generic
recovery claim or guessing whether credentials committed. A verified disconnect clears the uncertain
credential state and journal; it cannot run concurrently with any still-settling lifecycle call in
the same process.

Shutdown never calls `close` concurrently with admitted commit work. It first closes providers that
have no admitted commit, boundedly waits only for protected commit promises, closes the newly safe
providers, and then drains remaining work. It reports failure if any phase cannot settle. Providers
that cross a lifecycle boundary remain unavailable until their connection is reset, preventing a
late mutating call from overlapping a retry. Included providers must honor their `AbortSignal`;
forcibly terminating arbitrary in-process code requires a future process-isolation boundary.
Authenticated providers must make credential transitions transactional: a rejected or cancelled
connect/poll operation cannot leave a newly active credential. Provider work should complete in
memory before one serialized final commit. If a provider cannot prove that a credential commit or
rollback settled, it must expose an error state with no capabilities until a verified reset. Registry
shutdown aborts outstanding non-committing provider work, boundedly drains admitted commit tails,
and then invokes each safe provider's optional idempotent `close` hook.

Bundled skills are materialized into each configured Codex home only while their plugin, connection,
and at least one referenced capability are active. Ownership markers prevent a plugin
from replacing or deleting another plugin's or the user's skill. A Codex task also receives a
temporary integration-only skill root; that root is removed when the provider session closes.
Successful materializations are keyed by Codex home, package root, and active skill set, so routine
status refreshes do not recopy unchanged skill trees.

## Runtime exposure

MCP session credentials carry the stable coarse integration invocation scope so an already-running
provider session does not need a new credential when an included plugin is toggled. That transport
scope does not grant access to any provider by itself. MCP tool visibility and invocation still check
the live registry, plugin enablement, connection state, required manifest capability, tool
allowlisting, and provider enforcement.
Initial fixed-catalog MCP tools are registered on the awaited startup path. A collision or
registration failure therefore fails startup instead of leaving the Plugins UI advertising a tool
that MCP silently omitted. The catalog is immutable for the process lifetime.

Codex app-server tasks receive currently available provider tools as dynamic functions. Canonical
manifest names such as `fixture.records.search` map deterministically to Codex-safe names such as
`fixture_records_search`. Every call resolves through the live registry, so disable, disconnect,
capability loss, or provider failure continues to fail closed. Resume cursors fingerprint the full
dynamic-tool contract and start fresh when that contract changes. Tool input is decoded again at the
Registry choke point; transport validation is not treated as the security boundary.
Effective availability changes refresh every configured Codex provider snapshot immediately, with
debouncing to avoid poll storms. Idle sessions are recreated at the next turn boundary with their
resume cursor and model preserved; active turns are not interrupted. Revocation is immediate in
already-running tasks because every call still crosses the live registry.

## Included development fixtures

Set `TRITONAI_ENABLE_INTEGRATION_FIXTURES=1` for the server or desktop development runtime to include:

- **Skill-only Fixture**, which has no provider, credentials, or tools;
- **API Key MCP Fixture**, which accepts a test key through the generic API-key flow, stores it in
  the package-scoped server secret store, and exposes one deterministic read-only tool plus its own
  skill.

The fixtures exercise host abstractions. They are not production connectors and do not create a
marketplace.

## Plugins screen

Settings → Plugins renders one row per included package, keeping a catalog of many plugins
scannable. The top-level switch remains the master control. Expanding a row shows its connection,
one **Access** switch per user-facing capability, and read-only derived Tool and Skill status. Write
abilities are marked as following task access. Enabled plugins with an unresolved connection expand
automatically and keep a persistent, accessible Connect action visible.

## Deliberate follow-up work

Additional discriminated authorization experiences, declarative remote or stdio MCP loading,
provider process isolation, provider audit events, production credential UX, and mobile management
remain separate work. If external package distribution is ever added, allowlisting, signing, and a
separate trust model are required first. Removing an included production plugin also needs an
explicit provider-aware retirement migration so its scoped credentials can be deleted with its
retained state and package files. New providers should remain self-contained packages and avoid
provider-specific branches in registry, Codex, MCP, RPC, or Plugins UI code.
