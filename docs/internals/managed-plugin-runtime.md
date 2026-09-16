# Managed plugin host runtime

Managed provider packages load after the server bundle starts. Their Effect peer must therefore
be available as a package even when the server itself has inlined Effect. Windows stages that
peer and its dependency closure inside `server.asar` when composing managed plugins. The CLI's
upstream bundling rules and the Windows installer's loose-file budget remain unchanged.

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

The bundled server and external provider packages execute separate copies of Effect. Effect
4.0.0-beta.103 introduced an unchanged-input parser result whose identity must match across
those copies. Without that identity, the host can treat the parser sentinel as a tool argument:
valid calendar timestamps and other constrained inputs fail validation before provider invocation.

The pinned Effect patch shares the missing-input symbol and unchanged-input result within the
process. Both the server bundle and packaged peer runtime must be rebuilt with the patch;
replacing only one copy is insufficient. The cross-runtime input-contract test checks valid
values, absent optional fields, and rejection of invalid and excess fields. Preserve that test
when upgrading or removing the dependency patch.
