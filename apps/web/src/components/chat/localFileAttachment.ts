import type { DesktopBridge } from "@t3tools/contracts";

export function resolveDesktopLocalFilePath(input: {
  readonly bridge: Pick<DesktopBridge, "getLocalEnvironmentBootstraps" | "getPathForFile"> | null;
  readonly backendId: string | null;
  readonly file: File;
}): string | null {
  const getPathForFile = input.bridge?.getPathForFile;
  if (!getPathForFile || input.backendId === null) return null;

  try {
    const bootstrap = input.bridge
      .getLocalEnvironmentBootstraps()
      .find((candidate) => candidate.id === input.backendId);
    // A WSL or SSH server cannot read the host-native path. Those environments
    // retain the authenticated upload/copy fallback used before this optimization.
    if (!bootstrap || bootstrap.runningDistro != null) return null;
    const path = getPathForFile(input.file);
    return path && path.length > 0 ? path : null;
  } catch {
    return null;
  }
}
