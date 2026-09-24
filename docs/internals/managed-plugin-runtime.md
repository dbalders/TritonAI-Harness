# Managed plugin host runtime

Managed provider packages load after the server bundle starts. Their Effect peer must therefore
be available as a package. The server and provider packages share the pinned Effect 4.0.0-rc.112
runtime on disk. Windows stages that peer and its dependency closure inside `server.asar`.
The standalone WSL archive includes the same runtime, managed policy, plugin composition, and
a small disk-backed asynchronous module loader required by Node single-executable applications.

Provider snapshots cannot link to Electron's virtual archive directories. The Windows backend
copies the host runtime's installed dependency closure into a private temporary directory on
first use. Concurrent providers share that copy; the last provider to close removes it. Failed
copies are discarded and can be retried. macOS continues to link to `app.asar.unpacked`, and
the extracted WSL runtime links to its existing real dependency tree.
Copies record their owning process ID in the directory name. On the next materialization,
copies whose owner no longer exists are removed; live or inaccessible processes are preserved.

Packaging checks require the matching Effect package in the final Windows archive. The native
Windows boot check compares the plugins actually loaded at startup with the pinned composition,
and treats composition verification failures as release failures. Merely opening a window does
not prove managed plugins are available.
The verifier supplies a unique `TRITONAI_PLUGIN_BOOT_REPORT_PATH`; after provider loading,
the backend writes only its PID and loaded plugin IDs there. The verifier requires the exact
composition and a live reporting process. This does not depend on healthy child stderr being
persisted, and a report-write failure does not disable the application's providers.

## Effect schema identity across runtime copies

Providers built or tested with their own Effect copy can cross the host schema boundary. Effect
introduced an unchanged-input parser result whose identity must match across those copies. Without that identity, the host can treat the parser sentinel as a tool argument:
valid calendar timestamps and other constrained inputs fail validation before provider invocation.

The pinned Effect patch shares the missing-input symbol and unchanged-input result within the
process. The rc.112 patch preserves those sentinels across copies of the same runtime version.
Every host and provider runtime copy must use the matching patch. The cross-runtime input-contract test checks valid
values, absent optional fields, and rejection of invalid and excess fields. Preserve that test
when upgrading or removing the dependency patch.
