# Integration plugin foundation

TritonAI Harness integration plugins are versioned packages that compose provider behavior, MCP tools, and Codex skills behind one lifecycle. This repository contains the provider-neutral host foundation only. Real integration packages and provider implementations belong in the separate `TritonAI-Integrations` repository.

## Package contract

Every discovered package contains `.tritonai-plugin/plugin.json` with:

- `apiVersion: tritonai.harness/v1`, `kind: IntegrationPlugin`, and `manifestVersion: 1`;
- stable integration and provider identifiers plus a semantic package version;
- an explicit compatible Harness version range;
- capabilities and the tools and skills gated by each capability.

The registry rejects malformed manifests, unknown capability references, duplicate component names, provider/manifest mismatches, provider tool mismatches, incompatible Harness ranges, unsafe package paths, symlinks, special files, and staged manifests that differ from discovery. Compatibility is re-evaluated after restart; an installed package that no longer supports the current Harness or whose installed version differs from the discovered catalog version stays installed for safe removal but cannot enable tools or skills.

## Provider boundary

Provider-specific behavior implements the `IntegrationProvider` interface in `IntegrationRegistry.ts`. The provider owns connection and authorization behavior, credential persistence through host services supplied by its composition layer, status, tool definitions, invocation, and disconnection. Core RPC, MCP routing, and UI code operate only on generic integration summaries and lifecycle operations.

The v1 MCP grant is read-only. Provider registration and the MCP registration boundary both reject tools whose provider definition is not marked read-only. Write-capable integrations require a later credential, approval, and truthful tool-annotation contract rather than inheriting `integrations.read`.

Provider exceptions are private by default and become generic lifecycle errors at the client boundary. A provider may throw `IntegrationProviderPublicError` only for deliberately sanitized, user-actionable text. Successful tool results are JSON-normalized and wrapped into object-shaped MCP structured content; non-serializable results fail closed as unavailable.

Package discovery and provider registration are separate on purpose: `discoverPackage(packageRoot, provider)` reads and validates the external package while requiring the host composition layer to supply the matching provider implementation. The foundation ships with an empty catalog and no real provider code. A test-only package exercises this boundary without being installed in the product.

## Lifecycle

Installation stages an immutable versioned package, validates its complete contents, atomically publishes it, and then persists enablement. Failure removes staged files and restores the previous state. Installed and enabled state survives restart.

Disable, disconnect, and remove synchronously revoke tool availability and abort active provider work before their serialized lifecycle mutation runs. Disconnect preserves the installed package. Removal first requires successful provider disconnection, records a durable recovery phase, moves the package to a tombstone, commits removed state, and cleans the tombstone. Startup deterministically completes an interrupted removal.

Bundled skills are materialized into each configured Codex home only while their integration, connection, and capability are active. Ownership markers prevent one integration from deleting another integration's or the user's skill. Partial activation is rolled back, unmanaged collisions are preserved, and changes to configured Codex homes are reconciled.

## RPC, MCP, and credential boundary

The client receives only manifest metadata, generic lifecycle state, capability grants, account labels, status messages, and authorization-flow instructions. Provider credentials are not part of the RPC schemas.

Provider sessions need the separate `integrations.read` credential capability for both tool visibility and invocation. Harness grants it at session issuance only when the user has made at least one integration tool active through install, enablement, connection, and capability consent; preview-only sessions do not receive it. MCP also checks live registry availability in each handler, not only during `tools/list`.

The provider contract never requires credentials to enter browser state, settings JSON, logs, skills, chat, or MCP results. Provider packages must keep access and refresh credentials behind their server-side secret-store boundary.

## Integrations screen

Settings → Integrations renders the generic catalog supplied by the registry. Each card owns install, enablement, capability selection, connection progress, status and errors, tools, bundled skills, disable, disconnect, and remove. Operations and authorization polling are keyed per integration so concurrent cards cannot overwrite one another. The empty state is expected until an external catalog supplies packages.

## Codex alignment

The foundation follows Codex's small manifest, conventional hidden manifest directory, validated discovery, immutable versioned installation, explicit enabled state, and tool/skill composition. Harness adds a provider lifecycle, capability gating, server credential boundary, transactional removal, and live MCP authorization because those concerns are outside Codex's declarative plugin contract.

## Deliberate follow-up work

This foundation does not ship provider packages. Curated catalog transport, allowlisting and signing, automatic updates, provider process isolation, audit events, hosted MCP packages, mobile management, and write-capability approval require separate trust and distribution work. Keeping those mechanisms out of the first host PR also keeps provider implementations out of the Harness core repository.
