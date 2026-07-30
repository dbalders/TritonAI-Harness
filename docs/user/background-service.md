# Background Service Distribution Policy

TritonAI Harness does not expose the upstream background-service commands. That implementation
installs and updates the public `t3` npm package, which is the upstream T3 Code distribution rather
than a UCSD-managed TritonAI Harness package.

Desktop lifecycle and updates remain owned by TritonAI Installer and the installed desktop app. A
remote or headless server must be started and updated through the same approved managed process that
provisioned it. The app does not offer a public-package install command as a substitute.

The upstream boot-service implementation remains in the source tree for protocol compatibility and
future rebases, but it is not registered in the TritonAI Harness CLI and is not offered during
TritonAI Connect onboarding.

Do not enable the implementation for a TritonAI release until the project has a UCSD-owned server
artifact, authenticated update channel, and release validation proving that the requested Harness
version resolves to that artifact.
