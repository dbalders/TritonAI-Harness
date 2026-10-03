/**
 * Decides what one sync pass does to each file in the memory vault.
 *
 * Every generated file has exactly one writer: the computer whose short code
 * ends its name, or whose `.devices/<id>/` or `Inbox/<code>/` folder holds it.
 * This computer only uploads its own files and only downloads everyone
 * else's, so two computers never write the same file. `Notes/` is the one
 * folder the user edits by hand on any computer; it syncs both ways and keeps
 * both copies when both sides changed.
 *
 * Nothing here deletes a file without a surviving copy. A missing local file
 * is only treated as deleted when the last sync saw it and Harness removed it
 * on purpose; otherwise it is downloaded again.
 */

export type VaultPathClass = "own" | "other" | "notes" | "ignored";

export interface SyncDevice {
  readonly id: string;
  readonly shortId: string;
}

/** Vault-relative paths use `/` on every platform. */
export function classifyVaultPath(relativePath: string, device: SyncDevice): VaultPathClass {
  const segments = relativePath.split("/");
  const name = segments.at(-1) ?? "";
  if (name.length === 0 || name.endsWith(".tmp") || name === ".DS_Store") return "ignored";
  const [first, second] = segments;
  // Hidden folders are local: `.sync`, editor settings, archives, and the like.
  if (
    segments.some(
      (segment, index) => segment.startsWith(".") && !(index === 0 && segment === ".devices"),
    )
  ) {
    return "ignored";
  }
  if (segments.length < 2) return "ignored";
  switch (first) {
    case ".devices":
      return second === device.id ? "own" : "other";
    case "Notes":
      return "notes";
    case "Inbox":
      if (segments.length < 3) return "ignored";
      return second === device.shortId ? "own" : "other";
    case "Daily":
    case "Projects":
      return name.endsWith(` (${device.shortId}).md`) ? "own" : "other";
    default:
      return "ignored";
  }
}

export interface LocalFile {
  readonly sha256: string;
}

export interface CloudFile {
  readonly eTag: string;
}

/** What the last successful sync saw for a path on both sides. */
export interface SyncedFile {
  readonly sha256: string;
  readonly eTag: string;
}

export type SyncAction =
  /** Upload the local file; `ifMatch` null creates it and fails if it now exists. */
  | { readonly kind: "upload"; readonly path: string; readonly ifMatch: string | null }
  | { readonly kind: "download"; readonly path: string }
  /** Both sides have the file and there is no record: compare the contents. */
  | { readonly kind: "compare"; readonly path: string; readonly pathClass: VaultPathClass }
  /** This computer's file changed in the cloud: keep that copy, then upload ours. */
  | { readonly kind: "archiveThenUpload"; readonly path: string; readonly ifMatch: string }
  /** A note changed on both sides: keep the local copy under a conflict name, take the cloud one. */
  | { readonly kind: "conflictCopy"; readonly path: string }
  | { readonly kind: "deleteCloud"; readonly path: string; readonly ifMatch: string }
  | { readonly kind: "deleteLocal"; readonly path: string }
  | { readonly kind: "forget"; readonly path: string }
  /** Another install changed this computer's record: stop instead of fighting it. */
  | { readonly kind: "ownerConflict"; readonly path: string };

export interface SyncPlanInput {
  readonly device: SyncDevice;
  readonly local: ReadonlyMap<string, LocalFile>;
  readonly cloud: ReadonlyMap<string, CloudFile>;
  readonly synced: ReadonlyMap<string, SyncedFile>;
  /** Vault-relative paths Harness has written and not removed, from `written.json`. */
  readonly written: ReadonlySet<string>;
}

function isPendingOwnInboxNote(path: string, device: SyncDevice): boolean {
  const segments = path.split("/");
  return segments.length === 3 && segments[0] === "Inbox" && segments[1] === device.shortId;
}

/** Whether Harness took this file away itself rather than losing it. */
function removedOnPurpose(path: string, input: SyncPlanInput): boolean {
  // A consumed inbox note moved to `processed/<day>/`; its name may have
  // gained a suffix to avoid a collision. Require the original contents.
  if (isPendingOwnInboxNote(path, input.device)) {
    const original = input.synced.get(path);
    const prefix = `Inbox/${input.device.shortId}/processed/`;
    return (
      original !== undefined &&
      [...input.local].some(
        ([candidate, file]) =>
          candidate.startsWith(prefix) &&
          candidate.split("/").length === 5 &&
          file.sha256 === original.sha256,
      )
    );
  }
  // A generated note Harness removed drops out of `written.json`. The record
  // itself lives in this computer's device folder, so a lost vault loses it
  // too and every file is downloaded again instead.
  if (!path.startsWith("Daily/") && !path.startsWith("Projects/")) return false;
  const devicePrefix = `.devices/${input.device.id}/`;
  return input.local.has(`${devicePrefix}written.json`) && !input.written.has(path);
}

function planOwn(
  path: string,
  local: LocalFile | undefined,
  cloud: CloudFile | undefined,
  synced: SyncedFile | undefined,
  input: SyncPlanInput,
): SyncAction | null {
  if (local && !cloud) return { kind: "upload", path, ifMatch: null };
  if (local && cloud) {
    if (!synced) return { kind: "compare", path, pathClass: "own" };
    if (cloud.eTag !== synced.eTag) {
      if (path === `.devices/${input.device.id}/device.json`)
        return { kind: "ownerConflict", path };
      return { kind: "archiveThenUpload", path, ifMatch: cloud.eTag };
    }
    return local.sha256 === synced.sha256 ? null : { kind: "upload", path, ifMatch: cloud.eTag };
  }
  if (!local && cloud) {
    if (synced && cloud.eTag === synced.eTag && removedOnPurpose(path, input)) {
      return { kind: "deleteCloud", path, ifMatch: cloud.eTag };
    }
    return { kind: "download", path };
  }
  return synced ? { kind: "forget", path } : null;
}

function planOther(
  path: string,
  local: LocalFile | undefined,
  cloud: CloudFile | undefined,
  synced: SyncedFile | undefined,
): SyncAction | null {
  if (cloud) {
    const current = local && synced && cloud.eTag === synced.eTag && local.sha256 === synced.sha256;
    return current ? null : { kind: "download", path };
  }
  // Its owner removed it. A local file sync never saw is left alone.
  if (local && synced) return { kind: "deleteLocal", path };
  return synced ? { kind: "forget", path } : null;
}

function planNote(
  path: string,
  local: LocalFile | undefined,
  cloud: CloudFile | undefined,
  synced: SyncedFile | undefined,
): SyncAction | null {
  if (local && cloud) {
    if (!synced) return { kind: "compare", path, pathClass: "notes" };
    const localChanged = local.sha256 !== synced.sha256;
    const cloudChanged = cloud.eTag !== synced.eTag;
    if (localChanged && cloudChanged) return { kind: "conflictCopy", path };
    if (localChanged) return { kind: "upload", path, ifMatch: cloud.eTag };
    if (cloudChanged) return { kind: "download", path };
    return null;
  }
  if (local && !cloud) {
    // Deleted elsewhere: an edit made here since wins over the delete.
    if (synced && local.sha256 === synced.sha256) return { kind: "deleteLocal", path };
    return { kind: "upload", path, ifMatch: null };
  }
  if (!local && cloud) {
    if (synced && cloud.eTag === synced.eTag)
      return { kind: "deleteCloud", path, ifMatch: cloud.eTag };
    return { kind: "download", path };
  }
  return synced ? { kind: "forget", path } : null;
}

const ACTION_ORDER: Record<SyncAction["kind"], number> = {
  ownerConflict: 0,
  compare: 1,
  archiveThenUpload: 1,
  conflictCopy: 1,
  upload: 1,
  download: 1,
  deleteLocal: 2,
  deleteCloud: 2,
  forget: 3,
};

/**
 * Actions for every path either side or the last sync knows about. Deletes
 * come after uploads and downloads so a moved file exists in its new place
 * before its old copy goes.
 */
export function planMemorySync(input: SyncPlanInput): ReadonlyArray<SyncAction> {
  const paths = new Set([...input.local.keys(), ...input.cloud.keys(), ...input.synced.keys()]);
  const actions: SyncAction[] = [];
  for (const path of [...paths].toSorted()) {
    const pathClass = classifyVaultPath(path, input.device);
    const local = input.local.get(path);
    const cloud = input.cloud.get(path);
    const synced = input.synced.get(path);
    const action =
      pathClass === "own"
        ? planOwn(path, local, cloud, synced, input)
        : pathClass === "other"
          ? planOther(path, local, cloud, synced)
          : pathClass === "notes"
            ? planNote(path, local, cloud, synced)
            : null;
    if (action) actions.push(action);
  }
  return actions.toSorted((left, right) => ACTION_ORDER[left.kind] - ACTION_ORDER[right.kind]);
}

/**
 * Re-keys local and synced paths to the cloud's spelling when they differ
 * only in letter case. OneDrive and most desktop file systems ignore case, so
 * `Notes/plans.md` renamed to `Notes/Plans.md` is one file, not a new file and
 * a deleted one. Without this, a case-only rename would plan a download of
 * the new name and a delete of the old name that removes the same file.
 *
 * Two local files that differ only in case (possible on Linux) cannot both
 * exist in OneDrive; the later one is left out of sync.
 */
export function alignPathCase<L, C, S>(input: {
  readonly local: ReadonlyMap<string, L>;
  readonly cloud: ReadonlyMap<string, C>;
  readonly synced: ReadonlyMap<string, S>;
}): {
  readonly local: Map<string, L>;
  readonly synced: Map<string, S>;
  /** Canonical path to the path the file has on this computer's disk. */
  readonly diskPath: Map<string, string>;
} {
  const canonical = new Map<string, string>();
  for (const path of input.cloud.keys()) canonical.set(path.toLowerCase(), path);
  const spell = (path: string) => {
    const key = path.toLowerCase();
    const existing = canonical.get(key);
    if (existing !== undefined) return existing;
    canonical.set(key, path);
    return path;
  };
  const local = new Map<string, L>();
  const diskPath = new Map<string, string>();
  for (const [path, value] of input.local) {
    const aligned = spell(path);
    if (local.has(aligned)) continue;
    local.set(aligned, value);
    diskPath.set(aligned, path);
  }
  const synced = new Map<string, S>();
  for (const [path, value] of input.synced) {
    const aligned = spell(path);
    if (!synced.has(aligned) || aligned === path) synced.set(aligned, value);
  }
  return { local, synced, diskPath };
}

/** A name for the local side of a note both computers changed. */
export function conflictCopyPath(path: string, deviceLabel: string, stamp: string): string {
  const slash = path.lastIndexOf("/");
  const directory = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  return `${directory}${stem} (conflict ${deviceLabel} ${stamp})${extension}`;
}
