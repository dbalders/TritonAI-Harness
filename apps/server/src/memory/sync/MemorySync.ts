/**
 * MemorySync - keeps this computer's memory vault in step with a folder in
 * the user's OneDrive, so each of their computers sees every computer's notes.
 *
 * The vault stays a normal local folder that agents read directly; Harness is
 * the sync client. A pass runs shortly after startup, every five minutes, when
 * sync is turned on, and on request. It holds the summarizer's lock so a note
 * is never uploaded half written or replaced while Memory writes it. What a
 * pass does to each file is decided by `planMemorySync`.
 *
 * The same passes keep read-only copies of team memory in `teams/<folder>/`
 * (see `teamMirror.ts`), planned by `planTeamMirror`. Those copies never go to
 * OneDrive, and they hold their own lock, so a slow team folder never holds up
 * the summarizer.
 */
import {
  ServerMemorySyncError,
  type ServerMemoryStatus,
  type ServerMemorySyncPollResult,
  type ServerMemorySyncStartResult,
  type ServerMemorySyncStatus,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { DailyMemory } from "../DailyMemory.ts";
import {
  decodeDeviceRecord,
  findMemoryDevice,
  generalVaultPaths,
  type MemoryDevice,
  sha256Bytes,
} from "../memoryVault.ts";
import {
  alignPathCase,
  classifyVaultPath,
  type CloudFile,
  conflictCopyPath,
  type LocalFile,
  memoryOwnershipConflict,
  planMemorySync,
  planTeamMirror,
  type SyncAction,
  type SyncDevice,
  type SyncedFile,
} from "./memorySyncPlan.ts";
import {
  MemorySyncFailure,
  type MemorySyncSignInRequired,
  MicrosoftSignIn,
} from "./microsoftSignIn.ts";
import { type DriveItem, makeOneDrive, MAX_UPLOAD_BYTES } from "./oneDrive.ts";
import {
  TEAM_MIRROR_FOLDER,
  TeamMirrorHost,
  type TeamMirrorSource,
  type TeamMirrorTeam,
} from "./teamMirror.ts";

const SYNC_INTERVAL = Duration.minutes(5);

const isNotFound = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "reason" in error &&
  (error as { readonly reason?: { readonly _tag?: string } }).reason?._tag === "NotFound";
// Let startup and the first memory pass settle before the first sync.
const STARTUP_DELAY = Duration.seconds(45);

const CloudItem = Schema.Struct({
  name: Schema.String,
  parentId: Schema.String,
  eTag: Schema.NullOr(Schema.String),
  folder: Schema.Boolean,
});
type CloudItem = typeof CloudItem.Type;
const SyncState = Schema.Struct({
  version: Schema.Literal(1),
  accountId: Schema.String,
  driveId: Schema.String,
  rootId: Schema.String,
  deltaLink: Schema.NullOr(Schema.String),
  /** Everything below the cloud root, by item id. */
  items: Schema.Record(Schema.String, CloudItem),
  /** What the last sync saw on both sides, by vault-relative path. */
  synced: Schema.Record(
    Schema.String,
    Schema.Struct({
      sha256: Schema.String,
      eTag: Schema.String,
      ownerId: Schema.optionalKey(Schema.String),
    }),
  ),
  /** Written before uploading, so a restart can recover an unrecorded success. */
  pendingUploads: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
type SyncState = {
  -readonly [K in keyof typeof SyncState.Type]: (typeof SyncState.Type)[K] extends Readonly<
    Record<string, infer V>
  >
    ? Record<string, V>
    : (typeof SyncState.Type)[K];
};
const SyncStateJson = Schema.fromJsonString(SyncState);
const decodeSyncState = Schema.decodeUnknownEffect(SyncStateJson);
const encodeSyncState = Schema.encodeEffect(SyncStateJson);
const WrittenFiles = Schema.Struct({ files: Schema.Record(Schema.String, Schema.String) });
const decodeWrittenFiles = Schema.decodeUnknownEffect(Schema.fromJsonString(WrittenFiles));
/** What the last pass copied for each team folder, by vault-relative path. */
const TeamMirrorState = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    teams: Schema.Record(
      Schema.String,
      Schema.Struct({
        teamId: Schema.String,
        synced: Schema.Record(
          Schema.String,
          Schema.Struct({ sha256: Schema.String, eTag: Schema.String }),
        ),
      }),
    ),
  }),
);
type TeamMirrorEntry = { teamId: string; synced: Record<string, { sha256: string; eTag: string }> };
const decodeTeamMirrorState = Schema.decodeUnknownEffect(TeamMirrorState);
const encodeTeamMirrorState = Schema.encodeEffect(TeamMirrorState);
/**
 * Team documents downloaded per team in one pass. A small team is copied in one
 * pass; a large one catches up over the next few.
 */
const TEAM_DOWNLOADS_PER_PASS = 50;
/** A team document path is plain names joined by `/`, none of them hidden or relative. */
const isPlainRelativePath = (relativePath: string) =>
  relativePath
    .split("/")
    .every((segment) => segment.length > 0 && !segment.startsWith(".") && !segment.includes("\\"));

/**
 * The OneDrive folder for this install. Stable and Nightly keep separate
 * vaults locally, so they get separate folders in the cloud too.
 */
function cloudFolderSegments(baseDirName: string): ReadonlyArray<string> {
  const app =
    baseDirName === ".tritonai-harness"
      ? "TritonAI Harness"
      : baseDirName === ".tritonai-harness-nightly"
        ? "TritonAI Harness Nightly"
        : "TritonAI Harness Dev";
  return [app, "memory", "general"];
}

interface SyncRunStatus {
  readonly state: "idle" | "syncing" | "signed-out" | "error";
  readonly message: string | null;
  readonly lastSyncedAt: string | null;
}

export class MemorySync extends Context.Service<
  MemorySync,
  {
    readonly getStatus: Effect.Effect<ServerMemoryStatus>;
    /** Runs one pass now. Safe to call while another pass runs; it waits. */
    readonly syncNow: Effect.Effect<void>;
    readonly start: Effect.Effect<ServerMemorySyncStartResult, ServerMemorySyncError>;
    readonly poll: (
      flowId: string,
    ) => Effect.Effect<ServerMemorySyncPollResult, ServerMemorySyncError>;
    /** Turns sync off and cancels any sign-in still in progress. */
    readonly stop: Effect.Effect<void, ServerMemorySyncError>;
    readonly signOut: Effect.Effect<void, ServerMemorySyncError>;
    /** Team copies in the vault; see `teamMirror.ts`. */
    readonly teams: TeamMirrorHost["Service"];
  }
>()("t3/memory/sync/MemorySync") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const environment = yield* ServerEnvironment;
  const dailyMemory = yield* DailyMemory;
  const signIn = yield* MicrosoftSignIn;
  const oneDrive = yield* makeOneDrive;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vault = generalVaultPaths(path, config.memoryDir);
  const stateFile = path.join(vault.root, ".sync", "state.json");
  const segments = cloudFolderSegments(path.basename(config.baseDir));
  const cloudFolder = `OneDrive/${segments.join("/")}`;
  const environmentId = (yield* environment.getDescriptor).environmentId;
  const status = yield* Ref.make<SyncRunStatus>({
    state: "idle",
    message: null,
    lastSyncedAt: null,
  });
  const serverError = (message: string) => new ServerMemorySyncError({ message });

  const nowIso = Clock.currentTimeMillis.pipe(
    Effect.map((now) => DateTime.formatIso(DateTime.makeUnsafe(now))),
  );

  const readState = fs.readFileString(stateFile).pipe(
    Effect.flatMap((raw) => decodeSyncState(raw)),
    Effect.map((state): SyncState | null => ({
      ...state,
      items: { ...state.items },
      synced: { ...state.synced },
      pendingUploads: { ...state.pendingUploads },
    })),
    Effect.catchIf(isNotFound, () => Effect.succeed(null)),
    Effect.mapError(() => new MemorySyncFailure({ message: "Could not read the sync state." })),
  );

  const writeState = (state: SyncState) =>
    encodeSyncState(state).pipe(
      Effect.flatMap((json) =>
        fs
          .makeDirectory(path.dirname(stateFile), { recursive: true })
          .pipe(Effect.andThen(writeBytesAtomically(stateFile, new TextEncoder().encode(json)))),
      ),
      Effect.mapError(() => new MemorySyncFailure({ message: "Could not save the sync state." })),
    );

  /** Writes next to the target, then renames, so readers never see half a file. */
  const writeBytesAtomically = (filePath: string, bytes: Uint8Array) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.sync.tmp`;
      yield* fs.writeFile(temporary, bytes);
      yield* fs.rename(temporary, filePath);
    }).pipe(
      Effect.mapError(() => new MemorySyncFailure({ message: `Could not write ${filePath}.` })),
    );

  const toLocalPath = (relativePath: string) => path.join(vault.root, ...relativePath.split("/"));

  /**
   * The current bytes at a vault path, or null when no file is there. Any
   * other read error fails: a file sync cannot read must never look deleted.
   */
  const readLocal = (relativePath: string) =>
    Effect.gen(function* () {
      const filePath = toLocalPath(relativePath);
      const info = yield* fs.stat(filePath);
      if (info.type !== "File") return null;
      return yield* fs.readFile(filePath);
    }).pipe(
      Effect.catchIf(isNotFound, () => Effect.succeed(null)),
      Effect.mapError(
        () =>
          new MemorySyncFailure({
            message: `Could not read ${relativePath} from the memory folder.`,
          }),
      ),
    );

  /** Every file the plan cares about, with its bytes and hash. */
  const readLocalFiles = (device: MemoryDevice) =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectory(vault.root, { recursive: true }).pipe(
        // No memory folder at all is an empty vault; sync restores it.
        Effect.catchIf(isNotFound, () => Effect.succeed<ReadonlyArray<string>>([])),
        Effect.mapError(
          () => new MemorySyncFailure({ message: "Could not read the memory folder." }),
        ),
      );
      const files = new Map<string, { readonly bytes: Uint8Array; readonly sha256: string }>();
      for (const entry of entries) {
        const relativePath = entry.split(path.sep).join("/");
        const pathClass = classifyVaultPath(relativePath, device);
        // Team copies come from their team's folder and never go to OneDrive.
        if (pathClass === "ignored" || pathClass === "team") continue;
        const bytes = yield* readLocal(relativePath);
        if (bytes !== null) files.set(relativePath, { bytes, sha256: sha256Bytes(bytes) });
      }
      return files;
    });

  const readWritten = (device: MemoryDevice) =>
    fs.readFileString(path.join(vault.devices, device.id, "written.json")).pipe(
      Effect.flatMap((raw) => decodeWrittenFiles(raw)),
      Effect.map(
        (value) => new Set(Object.keys(value.files).map((key) => key.split(path.sep).join("/"))),
      ),
      Effect.catchIf(isNotFound, () => Effect.succeed(new Set<string>())),
      Effect.mapError(
        () =>
          new MemorySyncFailure({
            message:
              "Could not verify the written memory files. Sync stopped to preserve your notes.",
          }),
      ),
    );

  function applyItems(state: SyncState, items: ReadonlyArray<DriveItem>) {
    for (const item of items) {
      if (item.id === state.rootId) continue;
      if (item.deleted !== undefined) {
        delete state.items[item.id];
        continue;
      }
      const parentId = item.parentReference?.id;
      if (!parentId || item.name === undefined) continue;
      state.items[item.id] = {
        name: item.name,
        parentId,
        eTag: item.eTag ?? null,
        folder: item.folder !== undefined,
      };
    }
  }

  /** Vault-relative path of each cloud file, by walking parents up to the root. */
  function cloudPaths(state: SyncState) {
    const pathById = new Map<string, string | null>();
    const resolve = (id: string, depth: number): string | null => {
      if (id === state.rootId) return "";
      if (pathById.has(id)) return pathById.get(id) ?? null;
      const item = state.items[id];
      if (!item || depth > 64) return null;
      const parent = resolve(item.parentId, depth + 1);
      const resolved =
        parent === null ? null : parent === "" ? item.name : `${parent}/${item.name}`;
      pathById.set(id, resolved);
      return resolved;
    };
    const files = new Map<string, { readonly id: string; readonly eTag: string }>();
    const folders = new Map<string, string>();
    for (const [id, item] of Object.entries(state.items)) {
      const resolved = resolve(id, 0);
      if (resolved === null) continue;
      if (item.folder) folders.set(resolved.toLowerCase(), id);
      else if (item.eTag) files.set(resolved, { id, eTag: item.eTag });
    }
    return { files, folders };
  }

  const runPass = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!settings?.memoryEnabled || !settings.memorySyncEnabled || !signIn.config) return;
    const device = yield* findMemoryDevice(vault, environmentId);
    if (!device) {
      yield* Ref.update(status, (current) => ({
        ...current,
        state: "idle" as const,
        message: "Waiting for Memory to write its first notes.",
      }));
      return;
    }
    yield* Ref.update(status, (current) => ({
      ...current,
      state: "syncing" as const,
      message: null,
    }));

    const account = yield* oneDrive.account;
    const drive = yield* oneDrive.drive;
    let state = yield* readState;
    if (state && (state.accountId !== account.id || state.driveId !== drive.id)) {
      return yield* new MemorySyncFailure({
        message:
          "Memory last synced with a different Microsoft account. Sign in with that account, or sign out of sync to start over with this one.",
      });
    }
    if (!state) {
      state = {
        version: 1,
        accountId: account.id,
        driveId: drive.id,
        rootId: yield* oneDrive.ensureFolderPath(segments),
        deltaLink: null,
        items: {},
        synced: {},
        pendingUploads: {},
      };
    }
    const current = state;

    // Changes since the last pass; a lost cursor or folder starts from a full listing.
    let changes = yield* oneDrive.delta(current.rootId, current.deltaLink);
    if (changes.kind === "resync") {
      const rootId = yield* oneDrive.ensureFolderPath(segments);
      if (rootId !== current.rootId) {
        // The cloud folder itself was replaced; nothing in it was seen before.
        current.rootId = rootId;
        current.synced = {};
        current.pendingUploads = {};
      }
      current.items = {};
      changes = yield* oneDrive.delta(current.rootId, null);
      if (changes.kind === "resync") {
        return yield* new MemorySyncFailure({
          message: "OneDrive could not list the memory folder.",
        });
      }
    }
    applyItems(current, changes.items);
    current.deltaLink = changes.deltaLink;

    const outcome = yield* Effect.gen(function* () {
      const cloud = cloudPaths(current);
      // Read remote records before uploads, downloads to disk, or deletions. Local
      // registration cannot see another computer before its first sync.
      const remoteDevices: SyncDevice[] = [];
      for (const [filePath, remote] of cloud.files) {
        const match = /^\.devices\/([^/]+)\/device\.json$/iu.exec(filePath);
        if (!match) continue;
        const bytes = yield* oneDrive.download(remote.id);
        const record = yield* decodeDeviceRecord(new TextDecoder().decode(bytes)).pipe(
          Effect.mapError(
            () =>
              new MemorySyncFailure({
                message: `Memory ownership conflict: could not verify ${filePath}. Sync stopped to preserve your notes.`,
              }),
          ),
        );
        if (record.id !== match[1] || !record.shortId) {
          return yield* new MemorySyncFailure({
            message: `Memory ownership conflict: ${filePath} does not match its device identity. Sync stopped to preserve your notes.`,
          });
        }
        remoteDevices.push(record);
      }
      const conflict = memoryOwnershipConflict(device, remoteDevices);
      if (conflict) return yield* new MemorySyncFailure({ message: conflict.message! });
      // An upload may have reached OneDrive before its response or baseline
      // could be saved. Reconcile its recorded bytes before detecting edits
      // from another computer, even if the local file has since changed.
      const cloudByLowerPath = new Map(
        [...cloud.files].map(([filePath, remote]) => [
          filePath.toLowerCase(),
          { filePath, remote },
        ]),
      );
      for (const [filePath, sha256] of Object.entries(current.pendingUploads)) {
        const found = cloudByLowerPath.get(filePath.toLowerCase());
        if (found) {
          const bytes = yield* oneDrive.download(found.remote.id);
          if (sha256Bytes(bytes) === sha256) {
            current.synced[found.filePath] = { sha256, eTag: found.remote.eTag };
          }
        }
        delete current.pendingUploads[filePath];
      }
      const aligned = alignPathCase({
        local: yield* readLocalFiles(device),
        cloud: cloud.files,
        synced: new Map(Object.entries(current.synced)),
      });
      current.synced = Object.fromEntries(aligned.synced);
      const written = new Set(
        [...(yield* readWritten(device))].map(
          (filePath) => cloudByLowerPath.get(filePath.toLowerCase())?.filePath ?? filePath,
        ),
      );
      const actions = planMemorySync({
        device,
        remoteDevices,
        local: new Map<string, LocalFile>(
          [...aligned.local].map(([key, value]) => [key, { sha256: value.sha256 }]),
        ),
        cloud: new Map<string, CloudFile>(
          [...cloud.files].map(([key, value]) => [key, { eTag: value.eTag }]),
        ),
        synced: new Map<string, SyncedFile>(Object.entries(current.synced)),
        written,
      });
      yield* executeActions({
        device,
        written,
        state: current,
        local: aligned.local,
        diskPath: aligned.diskPath,
        cloud,
        actions,
      });
    }).pipe(Effect.exit);
    // Save successful actions even when a later one failed. A failed save is
    // itself a failed pass; upload intents already on disk survive a restart.
    yield* writeState(current);
    if (Exit.isFailure(outcome)) return yield* Effect.failCause(outcome.cause);
  });

  const executeActions = Effect.fn("memorySync.executeActions")(function* (input: {
    readonly device: MemoryDevice;
    readonly written: ReadonlySet<string>;
    readonly state: SyncState;
    readonly local: ReadonlyMap<string, { readonly bytes: Uint8Array; readonly sha256: string }>;
    /** Where each local file is on disk, when its letter case differs from the cloud's. */
    readonly diskPath: ReadonlyMap<string, string>;
    readonly cloud: {
      readonly files: ReadonlyMap<string, { readonly id: string; readonly eTag: string }>;
      readonly folders: Map<string, string>;
    };
    readonly actions: ReadonlyArray<SyncAction>;
  }) {
    const { state, local, cloud } = input;
    const skipped: string[] = [];
    const onDisk = (relativePath: string) => input.diskPath.get(relativePath) ?? relativePath;

    /**
     * Whether the local file is still what the scan saw. A note edited while
     * this pass ran is left alone; the next pass sees the edit.
     */
    const unchangedSinceScan = (relativePath: string) =>
      readLocal(onDisk(relativePath)).pipe(
        Effect.map((bytes) => {
          const scanned = local.get(relativePath)?.sha256 ?? null;
          return (bytes === null ? null : sha256Bytes(bytes)) === scanned;
        }),
      );

    const folderFor = Effect.fn("memorySync.folderFor")(function* (relativePath: string) {
      const parts = relativePath.split("/").slice(0, -1);
      let parentId = state.rootId;
      let prefix = "";
      for (const part of parts) {
        prefix = prefix ? `${prefix}/${part}` : part;
        const known = cloud.folders.get(prefix.toLowerCase());
        if (known) {
          parentId = known;
          continue;
        }
        const created = yield* oneDrive.ensureFolder(parentId, part);
        state.items[created] = { name: part, parentId, eTag: null, folder: true };
        cloud.folders.set(prefix.toLowerCase(), created);
        parentId = created;
      }
      return parentId;
    });

    const upload = Effect.fn("memorySync.upload")(function* (
      relativePath: string,
      bytes: Uint8Array,
      ifMatch: string | null,
    ) {
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        skipped.push(relativePath);
        return;
      }
      const parentId = yield* folderFor(relativePath);
      const name = relativePath.split("/").at(-1)!;
      const sha256 = sha256Bytes(bytes);
      state.pendingUploads[relativePath] = sha256;
      yield* writeState(state);
      const result = yield* oneDrive.upload(parentId, name, bytes, ifMatch);
      // Someone else wrote it first; the next pass sees their version.
      if (result.kind === "conflict") {
        delete state.pendingUploads[relativePath];
        return;
      }
      if (!result.item.eTag) return;
      delete state.pendingUploads[relativePath];
      state.items[result.item.id] = { name, parentId, eTag: result.item.eTag, folder: false };
      state.synced[relativePath] = {
        sha256,
        eTag: result.item.eTag,
        ...(input.written.has(relativePath) ? { ownerId: input.device.id } : {}),
      };
    });

    const downloadTo = Effect.fn("memorySync.downloadTo")(function* (relativePath: string) {
      const remote = cloud.files.get(relativePath)!;
      const bytes = yield* oneDrive.download(remote.id);
      return { bytes, eTag: remote.eTag };
    });

    const stamp = (yield* nowIso).replace(/[:.]/gu, "-");
    const archive = (relativePath: string, bytes: Uint8Array) =>
      writeBytesAtomically(
        toLocalPath(`.devices/${input.device.id}/.archive/${stamp}/${relativePath}`),
        bytes,
      );

    for (const action of input.actions) {
      switch (action.kind) {
        case "ownerConflict":
          return yield* new MemorySyncFailure({
            message:
              action.message ??
              "Another installation is writing memory as this computer, so sync stopped. Turn sync off on one of them.",
          });
        case "upload":
          yield* upload(action.path, local.get(action.path)!.bytes, action.ifMatch);
          break;
        case "download": {
          const { bytes, eTag } = yield* downloadTo(action.path);
          if (!(yield* unchangedSinceScan(action.path))) break;
          yield* writeBytesAtomically(toLocalPath(onDisk(action.path)), bytes);
          const sha256 = sha256Bytes(bytes);
          const previous = state.synced[action.path];
          state.synced[action.path] = {
            sha256,
            eTag,
            ...(previous?.sha256 === sha256 && previous.ownerId
              ? { ownerId: previous.ownerId }
              : {}),
          };
          break;
        }
        case "compare":
        case "archiveThenUpload":
        case "conflictCopy": {
          const mine = local.get(action.path)!;
          const { bytes, eTag } = yield* downloadTo(action.path);
          if (sha256Bytes(bytes) === mine.sha256) {
            const previous = state.synced[action.path];
            state.synced[action.path] = {
              sha256: mine.sha256,
              eTag,
              ...(previous?.sha256 === mine.sha256 && previous.ownerId
                ? { ownerId: previous.ownerId }
                : {}),
            };
            break;
          }
          const isNote =
            action.kind === "conflictCopy" ||
            (action.kind === "compare" && action.pathClass === "notes");
          if (isNote) {
            if (!(yield* unchangedSinceScan(action.path))) break;
            // Keep both: this computer's version under a conflict name, the cloud one in place.
            const copy = conflictCopyPath(action.path, input.device.label, stamp);
            yield* writeBytesAtomically(toLocalPath(copy), mine.bytes);
            yield* writeBytesAtomically(toLocalPath(onDisk(action.path)), bytes);
            state.synced[action.path] = { sha256: sha256Bytes(bytes), eTag };
          } else {
            yield* archive(action.path, bytes);
            yield* upload(action.path, mine.bytes, eTag);
          }
          break;
        }
        case "deleteCloud": {
          // Only while the file is still gone here.
          if (!(yield* unchangedSinceScan(action.path))) break;
          const remote = cloud.files.get(action.path)!;
          if ((yield* oneDrive.remove(remote.id, action.ifMatch)) === "deleted") {
            delete state.items[remote.id];
            delete state.synced[action.path];
          }
          break;
        }
        case "deleteLocal":
          if (!(yield* unchangedSinceScan(action.path))) break;
          yield* fs.remove(toLocalPath(onDisk(action.path))).pipe(
            Effect.catchIf(isNotFound, () => Effect.void),
            Effect.mapError(
              () =>
                new MemorySyncFailure({
                  message: `Could not remove ${action.path} from the memory folder.`,
                }),
            ),
          );
          delete state.synced[action.path];
          break;
        case "forget":
          delete state.synced[action.path];
          break;
      }
    }
    if (skipped.length > 0) {
      yield* Ref.update(status, (current) => ({
        ...current,
        message: `${skipped.length} file${skipped.length === 1 ? " is" : "s are"} larger than 4 MB and did not sync.`,
      }));
    }
  });

  const recordOutcome = <E extends MemorySyncFailure | MemorySyncSignInRequired>(
    effect: Effect.Effect<void, E>,
  ) =>
    effect.pipe(
      Effect.andThen(
        nowIso.pipe(
          Effect.flatMap((at) =>
            Ref.update(status, (current) => ({
              state: "idle" as const,
              message: current.message,
              lastSyncedAt: current.state === "syncing" ? at : current.lastSyncedAt,
            })),
          ),
        ),
      ),
      Effect.catch((error) =>
        Ref.update(status, (current) => ({
          ...current,
          state:
            error._tag === "MemorySyncSignInRequired"
              ? ("signed-out" as const)
              : ("error" as const),
          message: error.message,
        })),
      ),
      // A bug in one pass must not stop the schedule.
      Effect.catchDefect((defect) =>
        Effect.logWarning("memory sync failed", { defect }).pipe(
          Effect.andThen(
            Ref.update(status, (current) => ({
              ...current,
              state: "error" as const,
              message: "Memory sync failed. It will try again shortly.",
            })),
          ),
        ),
      ),
    );

  const syncNow = dailyMemory.exclusive(
    recordOutcome(
      runPass.pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      ),
    ),
  );

  const syncStatus = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    const run = yield* Ref.get(status);
    const signedIn = yield* signIn.account;
    const state: ServerMemorySyncStatus["state"] = !signIn.config
      ? "unavailable"
      : !settings?.memorySyncEnabled
        ? "off"
        : run.state;
    return {
      state,
      signedIn: signedIn !== null,
      account: signedIn?.account ?? null,
      cloudFolder,
      lastSyncedAt: run.lastSyncedAt,
      message: state === "off" || state === "unavailable" ? null : run.message,
    } satisfies ServerMemorySyncStatus;
  });

  const getStatus = Effect.all([dailyMemory.getStatus, syncStatus]).pipe(
    Effect.map(([vaultStatus, sync]) => ({ ...vaultStatus, sync }) satisfies ServerMemoryStatus),
  );

  // Turning the setting on starts the first pass through the layer's settings watch.
  // It runs only as part of a sign-in, so a cancelled sign-in cannot turn sync on.
  const enable = settingsService.updateSettings({ memorySyncEnabled: true }).pipe(
    Effect.mapError(() => serverError("Could not turn on memory sync.")),
    Effect.asVoid,
  );
  const disable = settingsService.updateSettings({ memorySyncEnabled: false }).pipe(
    Effect.mapError(() => serverError("Could not turn off memory sync.")),
    Effect.asVoid,
  );

  const start = Effect.gen(function* () {
    if (!signIn.config) {
      return yield* serverError("This version of TritonAI Harness cannot sign in to Microsoft.");
    }
    return yield* signIn.start(enable).pipe(Effect.mapError((error) => serverError(error.message)));
  });

  const poll = (flowId: string) =>
    signIn
      .pollDeviceCode(flowId, enable)
      .pipe(Effect.mapError((error) => serverError(error.message)));

  // Cancel before writing false: a sign-in that finished first is turned off by
  // the write, and one finishing later is refused.
  const stop = signIn.cancelSignIn.pipe(Effect.andThen(disable));

  const signOut = dailyMemory.exclusive(
    Effect.gen(function* () {
      yield* stop;
      yield* signIn.signOut.pipe(Effect.mapError((error) => serverError(error.message)));
      // Another account starts from a clean slate; notes stay on this computer.
      yield* fs.remove(stateFile).pipe(Effect.ignore);
      yield* Ref.set(status, { state: "idle", message: null, lastSyncedAt: null });
    }),
  );

  const teamSource = yield* Ref.make<TeamMirrorSource | null>(null);
  const teamLock = yield* Semaphore.make(1);
  const teamsDirectory = path.join(vault.root, "teams");
  const teamStateFile = path.join(vault.root, ".sync", "teams.json");

  // A missing or unreadable record only costs downloading the copies again.
  const readTeamState = fs.readFileString(teamStateFile).pipe(
    Effect.flatMap((raw) => decodeTeamMirrorState(raw)),
    Effect.map((state): Record<string, TeamMirrorEntry> =>
      Object.fromEntries(
        Object.entries(state.teams).map(([folder, entry]) => [
          folder,
          { teamId: entry.teamId, synced: { ...entry.synced } },
        ]),
      ),
    ),
    Effect.orElseSucceed((): Record<string, TeamMirrorEntry> => ({})),
  );
  // Encodes when run, not when built: passes write the record they finished with.
  const writeTeamState = (teams: Record<string, TeamMirrorEntry>) =>
    Effect.suspend(() => encodeTeamMirrorState({ version: 1, teams })).pipe(
      Effect.flatMap((json) => writeBytesAtomically(teamStateFile, new TextEncoder().encode(json))),
      Effect.mapError(
        () => new MemorySyncFailure({ message: "Could not save the team copy records." }),
      ),
    );

  const removeTeamCopy = (folder: string) =>
    fs.remove(path.join(teamsDirectory, folder), { recursive: true }).pipe(
      Effect.catchIf(isNotFound, () => Effect.void),
      Effect.mapError(
        () =>
          new MemorySyncFailure({
            message: `Could not remove the local copy in teams/${folder}.`,
          }),
      ),
    );

  /**
   * Leaves only the active teams' folders in `teams/`. Harness manages that
   * folder, so anything else in it goes too.
   */
  const pruneTeamCopies = (
    teams: Record<string, TeamMirrorEntry>,
    active: ReadonlyArray<TeamMirrorTeam>,
  ) =>
    Effect.gen(function* () {
      const keep = new Map(active.map((team) => [team.folder, team.teamId]));
      const entries = yield* fs.readDirectory(teamsDirectory).pipe(
        Effect.catchIf(isNotFound, () => Effect.succeed<ReadonlyArray<string>>([])),
        Effect.mapError(
          () => new MemorySyncFailure({ message: "Could not read the teams folder." }),
        ),
      );
      for (const name of entries) if (!keep.has(name)) yield* removeTeamCopy(name);
      for (const [folder, entry] of Object.entries(teams)) {
        // A folder handed to another team starts over.
        if (keep.get(folder) !== entry.teamId) {
          if (keep.has(folder)) yield* removeTeamCopy(folder);
          delete teams[folder];
        }
      }
    });

  const activeTeams = (source: TeamMirrorSource) =>
    source.teams.pipe(
      Effect.map((teams) => {
        const seen = new Set<string>();
        return teams.filter((team) => {
          if (!TEAM_MIRROR_FOLDER.test(team.folder) || seen.has(team.folder)) return false;
          seen.add(team.folder);
          return true;
        });
      }),
    );

  /** Brings one team's copy in line with its folder; returns false when the copy was removed. */
  const syncTeamCopy = Effect.fn("memorySync.syncTeamCopy")(function* (
    source: TeamMirrorSource,
    team: TeamMirrorTeam,
    teams: Record<string, TeamMirrorEntry>,
  ) {
    const detach = Effect.gen(function* () {
      yield* removeTeamCopy(team.folder);
      delete teams[team.folder];
    });
    const listing = yield* source.list(team.teamId);
    if (listing.kind === "detached") return yield* detach;
    if (listing.kind === "unavailable") return;
    const prefix = `teams/${team.folder}/`;
    const cloud = new Map(
      listing.files
        .filter((file) => isPlainRelativePath(file.path))
        .map((file) => [`${prefix}${file.path}`, { eTag: file.eTag }] as const),
    );
    const entries = yield* fs
      .readDirectory(path.join(teamsDirectory, team.folder), { recursive: true })
      .pipe(
        Effect.catchIf(isNotFound, () => Effect.succeed<ReadonlyArray<string>>([])),
        Effect.mapError(
          () => new MemorySyncFailure({ message: "Could not read the team's local copy." }),
        ),
      );
    const local = new Map<string, { readonly sha256: string }>();
    for (const entry of entries) {
      const relativePath = `${prefix}${entry.split(path.sep).join("/")}`;
      const bytes = yield* readLocal(relativePath);
      if (bytes !== null) local.set(relativePath, { sha256: sha256Bytes(bytes) });
    }
    const entry = teams[team.folder] ?? { teamId: team.teamId, synced: {} };
    teams[team.folder] = entry;
    // Recorded before the first download, so a copy cut short is still known.
    yield* writeTeamState(teams);
    const unchangedSinceScan = (relativePath: string) =>
      readLocal(relativePath).pipe(
        Effect.map(
          (bytes) =>
            (bytes === null ? null : sha256Bytes(bytes)) ===
            (local.get(relativePath)?.sha256 ?? null),
        ),
      );
    let downloads = 0;
    let skipped = 0;
    let pending = 0;
    for (const action of planTeamMirror({
      local,
      cloud,
      synced: new Map(Object.entries(entry.synced)),
    })) {
      switch (action.kind) {
        case "download": {
          if (downloads >= TEAM_DOWNLOADS_PER_PASS) {
            pending++;
            break;
          }
          downloads++;
          const document = yield* source.read(team.teamId, action.path.slice(prefix.length));
          if (document.kind === "detached") return yield* detach;
          // Access couldn't be checked: keep what was copied and stop for this pass.
          if (document.kind === "unavailable") return;
          if (document.kind === "skip") {
            skipped++;
            break;
          }
          if (!(yield* unchangedSinceScan(action.path))) break;
          const bytes = new TextEncoder().encode(document.text);
          yield* writeBytesAtomically(toLocalPath(action.path), bytes);
          entry.synced[action.path] = { sha256: sha256Bytes(bytes), eTag: document.eTag };
          break;
        }
        case "deleteLocal":
          if (!(yield* unchangedSinceScan(action.path))) break;
          yield* fs.remove(toLocalPath(action.path)).pipe(
            Effect.catchIf(isNotFound, () => Effect.void),
            Effect.mapError(
              () => new MemorySyncFailure({ message: `Could not remove ${action.path}.` }),
            ),
          );
          delete entry.synced[action.path];
          break;
        case "forget":
          delete entry.synced[action.path];
          break;
      }
    }
    yield* writeTeamState(teams);
    yield* source.report(team.teamId, {
      kind: "synced",
      at: yield* nowIso,
      files: cloud.size,
      skipped,
      pending,
    });
  });

  const withTeamSource = (
    run: (
      source: TeamMirrorSource,
      teams: Record<string, TeamMirrorEntry>,
      active: ReadonlyArray<TeamMirrorTeam>,
    ) => Effect.Effect<void, MemorySyncFailure | PlatformError.PlatformError>,
  ) =>
    teamLock.withPermits(1)(
      Effect.gen(function* () {
        const source = yield* Ref.get(teamSource);
        // Nothing is known about team copies until the Teams side attaches.
        if (!source) return;
        const teams = yield* readTeamState;
        const active = yield* activeTeams(source);
        yield* pruneTeamCopies(teams, active).pipe(
          Effect.ensuring(writeTeamState(teams).pipe(Effect.ignore)),
        );
        yield* run(source, teams, active);
      }).pipe(
        Effect.catch((error) => Effect.logWarning("team memory copy failed", { error })),
        Effect.catchDefect((defect) => Effect.logWarning("team memory copy failed", { defect })),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      ),
    );

  const teamHost = TeamMirrorHost.of({
    attach: (source) => Ref.set(teamSource, source),
    prune: withTeamSource(() => Effect.void),
    sync: withTeamSource((source, teams, active) =>
      Effect.forEach(
        active,
        (team) =>
          syncTeamCopy(source, team, teams).pipe(
            Effect.catch((error) =>
              Effect.logWarning("team memory copy failed", { error }).pipe(
                Effect.andThen(
                  source.report(team.teamId, {
                    kind: "failed",
                    message:
                      error._tag === "MemorySyncFailure"
                        ? error.message
                        : "The local copy could not be updated.",
                  }),
                ),
              ),
            ),
          ),
        { discard: true },
      ).pipe(Effect.ensuring(writeTeamState(teams).pipe(Effect.ignore))),
    ),
  });

  return MemorySync.of({ getStatus, syncNow, start, poll, stop, signOut, teams: teamHost });
});

/**
 * Syncs after startup, every five minutes, and whenever sync or Memory is
 * switched. Team copies refresh after startup and every five minutes.
 */
export const layer = Layer.effect(
  MemorySync,
  Effect.gen(function* () {
    const service = yield* make;
    const settings = yield* ServerSettingsService;
    yield* Effect.sleep(STARTUP_DELAY).pipe(
      Effect.andThen(
        service.syncNow.pipe(
          Effect.andThen(service.teams.sync),
          Effect.repeat(Schedule.spaced(SYNC_INTERVAL)),
        ),
      ),
      Effect.forkScoped,
    );
    yield* settings.streamChanges.pipe(
      Stream.map((next) => next.memoryEnabled && next.memorySyncEnabled),
      Stream.changes,
      Stream.runForEach(() => service.syncNow),
      Effect.forkScoped,
    );
    return service;
  }),
);

/** The engine's side of team copies, for the Teams services. */
export const teamMirrorHostLayer = Layer.effect(
  TeamMirrorHost,
  Effect.gen(function* () {
    return (yield* MemorySync).teams;
  }),
);
