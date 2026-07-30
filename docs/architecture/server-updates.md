# Server Update Architecture

TritonAI Harness retains T3 Code's server-update contracts and implementation so protocol evolution
can continue to merge cleanly, but its downstream distribution policy keeps public-package update
paths dormant.

## Downstream policy

`ExecutionEnvironmentDescriptor.capabilities.serverSelfUpdate` remains backward compatible. The
effective TritonAI behavior is:

| Advertised value            | TritonAI behavior                                                              |
| --------------------------- | ------------------------------------------------------------------------------ |
| `desktop-managed`           | Show informational guidance to update the owning TritonAI Harness desktop app. |
| `boot-service` or `respawn` | Ignore the capability; do not send `server.updateServer`.                      |
| absent                      | Show version-skew information without generating a package-manager command.    |

TritonAI servers advertise `desktop-managed` only when the desktop app owns the backend.
Non-desktop servers omit the capability. The web client also filters capabilities because a
connected older or upstream server may still advertise a public-package update path.

The update action never renders an automatic-update button or copies an npm command for
non-desktop servers. This client-side boundary is required even when the local server is correctly
configured.

## Why the upstream path is disabled

The dormant implementation installs an exact version of the public `t3` npm package into a pinned
runtime, verifies it, and then restarts or replaces the server. TritonAI Harness product versions are
not published through that upstream distribution. Combining a TritonAI client version with that
package name would fail or install the wrong product.

The background-service command and its TritonAI Connect onboarding offer are therefore not registered in
the downstream CLI. Internal implementation and tests remain to minimize future upstream sync cost.

## Re-enablement requirements

Re-enabling remote updates requires all of the following:

1. a UCSD-owned server artifact and authenticated distribution channel;
2. explicit package/artifact identity in the update contract rather than an assumed public package;
3. release ordering that proves the exact server artifact exists before a client advertises it;
4. negative tests showing upstream capabilities and package identities cannot cross the downstream
   boundary;
5. installed-app and remote-server regression evidence.

Until those gates are met, GitHub Harness assets and TritonAI Installer remain the supported product
distribution path.
