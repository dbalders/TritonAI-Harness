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
