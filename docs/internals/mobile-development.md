# Mobile development lifecycle

## UCSD iOS signing

The iOS app uses the University of California, San Diego (Business Affairs)
team (`G789749RTK`). Production uses `edu.ucsd.tritonai.harness`; development
and preview append `.dev` and `.preview`. Widget and sharing extension IDs,
and the matching App Group, derive from the selected iOS bundle identifier.
Expo prebuild reads these values from `apps/mobile/app.config.ts`; changing
only the generated Xcode project will not persist across a clean prebuild.

The production EAS submit profile targets UCSD's TritonAI Harness App Store
Connect record (`6813147394`). Signing certificates and provisioning profiles
must belong to UCSD.

EAS Build and Update use the existing `@dbalders/t3-code` Expo project
(`dec81a5b-db3d-4de0-a00c-532e6e456a98`). The app's `owner`,
`extra.eas.projectId`, and `updates.url` must stay aligned with that project;
the `t3-code` slug is retained to match its existing Expo identity. Regenerate
native projects after changing this configuration. Installed binaries need a
new native build to adopt the new update URL.

The repository still contains upstream Clerk associated domains. Configure
TritonAI authentication and verify EAS credentials and environment variables
before publishing builds or OTA updates. Project linkage and signing settings
alone do not establish release readiness.

## Development refresh

Ordinary component changes use Metro Fast Refresh. The connection runtime uses
a stable development-only atom runtime whose writable layer atom receives the
newly evaluated Effect layer. Its module accepts the update only after installing
that layer. Existing subscribers observe the new context, and Effect releases the
previous runtime scope without restarting React Navigation. Production uses an
ordinary `Atom.runtime` without this hot-update boundary.

Replacing the atom registry itself disposes its old nodes; replacing the managed
runtime starts its asynchronous disposal. These modules use normal Metro update
propagation. The app does not call `DevSettings.reload` during their replacement.
React can still reset state when its normal Fast Refresh rules require it.

Do not reset the shared registry to clean up a connection-runtime edit: registry
reset removes listeners from unedited mounted consumers. Do not self-accept a
runtime module while leaving importers attached to its old implementation. A
hot-update boundary must install fresh behavior through the existing reactive
dependencies. These boundaries do not make every module-level atom family in the
app hot-swappable; new runtime singletons still need explicit ownership. Editing
the registry or managed runtime can still rebuild a much larger dependency graph
than an ordinary component or connection-runtime edit.

Environment supervisor scopes are children of the connection registry scope.
The registry's per-environment map supports targeted shutdown, but it cannot be
the sole owner: a supervisor created after that map's finalizer has run must
still inherit the closed parent scope. Otherwise interrupted startup or runtime
replacement can leave a session and WebSocket alive outside the current registry.

The compact Home list owns its minute-based presentation clock in a focus effect.
Blur clears the interval without a render-driving focus subscription; focus
refreshes the clock immediately. Other prop or state changes can still render
the hidden list. Exact snooze-expiry timers remain active, and the visible iPad
sidebar keeps its own minute updates.

Connection and runtime projections are shared per environment. Thread selection
consumers should read those atoms instead of repeatedly parsing the same socket
URL or constructing new connection objects during each render.

The Uniwind dependency patch still recompiles CSS on Metro updates so newly used
classes are discovered. It fingerprints the generated native stylesheet and
theme list, then skips development-only global invalidation when that output is
unchanged. A changed stylesheet or theme list still resets the style caches and
notifies subscribers. The digest is committed only after initialization succeeds.
Web and production retain their existing initialization behavior.

After installing or changing the Uniwind patch, restart Metro once with
`vp run dev:client:reset` from `apps/mobile`. pnpm gives patched packages new
filesystem paths, and cached transforms can otherwise retain references to the
previous package. Ordinary development starts should retain the transform cache.
