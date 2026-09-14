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

Packaging checks require the matching Effect package in the final Windows archive. The native
Windows boot check compares the plugins actually loaded at startup with the pinned composition,
and treats composition verification failures as release failures. Merely opening a window does
not prove managed plugins are available.
