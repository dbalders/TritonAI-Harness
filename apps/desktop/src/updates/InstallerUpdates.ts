import type {
  InstallerUpdateActionResult,
  InstallerUpdateCheckResult,
  InstallerUpdateState,
  InstallerVersionMarkerStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";

export const INSTALLER_VERSION_MARKER_RELATIVE_PATH = [
  ".agents",
  "ucsd",
  "state",
  "installer-version.json",
] as const;

const GITHUB_RELEASE_URL =
  "https://api.github.com/repos/dbalders/TritonAI-Installer/releases/latest";
const GITHUB_DOWNLOAD_PATH_PREFIX = "/dbalders/TritonAI-Installer/releases/download/";
const MAX_RELEASE_RESPONSE_BYTES = 512 * 1024;
const MAX_MARKER_BYTES = 16 * 1024;
const INSTALLER_UPDATE_POLL_INTERVAL = Duration.hours(6);
const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

class InstallerReleaseFetchError extends Schema.TaggedErrorClass<InstallerReleaseFetchError>()(
  "InstallerReleaseFetchError",
  { cause: Schema.Defect() },
) {}

function parseContentLengthHeader(value: string | undefined): number | null {
  if (!value || !/^\d+$/u.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function readLimitedReleaseText(response: HttpClientResponse.HttpClientResponse) {
  const contentLength = parseContentLengthHeader(response.headers["content-length"]);
  if (contentLength !== null && contentLength > MAX_RELEASE_RESPONSE_BYTES) {
    return Effect.fail(new InstallerReleaseFetchError({ cause: "GitHub response was too large" }));
  }

  const decoder = new TextDecoder();
  return response.stream.pipe(
    Stream.runFoldEffect(
      () => ({ bytes: 0, chunks: [] as string[] }),
      (state, chunk) => {
        const bytes = state.bytes + chunk.byteLength;
        if (bytes > MAX_RELEASE_RESPONSE_BYTES) {
          return Effect.fail(
            new InstallerReleaseFetchError({ cause: "GitHub response was too large" }),
          );
        }
        state.chunks.push(decoder.decode(chunk, { stream: true }));
        return Effect.succeed({ bytes, chunks: state.chunks });
      },
    ),
    Effect.map((state) => {
      const tail = decoder.decode();
      return tail ? [...state.chunks, tail].join("") : state.chunks.join("");
    }),
  );
}

interface InstallerReleaseAsset {
  readonly name: string;
  readonly url: string;
}

interface StableInstallerRelease {
  readonly version: string;
  readonly assets: readonly unknown[];
}

export interface InstallerVersionMarkerReadResult {
  readonly status: InstallerVersionMarkerStatus;
  readonly version: string | null;
}

export function normalizeStableInstallerVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^v/i, "");
  return STABLE_VERSION_PATTERN.test(normalized) ? normalized : null;
}

function numericVersionParts(version: string): readonly number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

export function compareInstallerVersions(left: string, right: string): number {
  const normalizedLeft = normalizeStableInstallerVersion(left);
  const normalizedRight = normalizeStableInstallerVersion(right);
  if (!normalizedLeft || !normalizedRight) {
    throw new Error("Installer versions must be stable numeric versions.");
  }

  const leftParts = numericVersionParts(normalizedLeft);
  const rightParts = numericVersionParts(normalizedRight);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseStableInstallerRelease(raw: unknown): StableInstallerRelease {
  if (!isRecord(raw) || raw.draft !== false || raw.prerelease !== false) {
    throw new Error("TritonAI Installer release data was invalid.");
  }
  const version = normalizeStableInstallerVersion(raw.tag_name);
  if (!version || !Array.isArray(raw.assets)) {
    throw new Error("No stable TritonAI Installer release is available.");
  }
  return { version, assets: raw.assets };
}

export function expectedInstallerAssetName(
  version: string,
  platform: NodeJS.Platform,
  arch: string,
): string {
  const normalizedVersion = normalizeStableInstallerVersion(version);
  if (!normalizedVersion) {
    throw new Error("The latest TritonAI Installer version was invalid.");
  }
  if (platform === "darwin" && arch === "arm64") {
    return `UCSD-AI-Tools-Installer-${normalizedVersion}-arm64.dmg`;
  }
  if (platform === "win32" && arch === "x64") {
    return `UCSD-AI-Tools-Installer-Setup-${normalizedVersion}-x64.exe`;
  }
  throw new Error(
    `TritonAI Installer updates are not available for ${platform}/${arch}. Use a supported macOS arm64 or Windows x64 computer.`,
  );
}

function validateInstallerAssetUrl(
  rawUrl: unknown,
  expectedName: string,
  version: string,
): string | null {
  if (typeof rawUrl !== "string") return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
    if (url.search || url.hash) return null;
    const decodedPath = decodeURIComponent(url.pathname);
    const expectedPaths = new Set([
      `${GITHUB_DOWNLOAD_PATH_PREFIX}${version}/${expectedName}`,
      `${GITHUB_DOWNLOAD_PATH_PREFIX}v${version}/${expectedName}`,
    ]);
    if (!expectedPaths.has(decodedPath)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function selectInstallerReleaseAsset(
  release: StableInstallerRelease,
  platform: NodeJS.Platform,
  arch: string,
): InstallerReleaseAsset {
  const expectedName = expectedInstallerAssetName(release.version, platform, arch);
  for (const candidate of release.assets) {
    if (!isRecord(candidate) || candidate.name !== expectedName) continue;
    const url = validateInstallerAssetUrl(
      candidate.browser_download_url,
      expectedName,
      release.version,
    );
    if (url) return { name: expectedName, url };
  }
  throw new Error(`The stable TritonAI Installer release is missing ${expectedName}.`);
}

export function parseInstallerVersionMarker(raw: string | null): InstallerVersionMarkerReadResult {
  if (raw === null) {
    return { status: "missing", version: null };
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_MARKER_BYTES) {
    return { status: "corrupt", version: null };
  }

  try {
    const marker: unknown = JSON.parse(raw);
    if (!isRecord(marker) || marker.schemaVersion !== 1) {
      return { status: "corrupt", version: null };
    }
    const version = normalizeStableInstallerVersion(marker.version);
    if (!version || typeof marker.installedAt !== "string") {
      return { status: "corrupt", version: null };
    }
    const installedAt = Date.parse(marker.installedAt);
    if (!Number.isFinite(installedAt)) {
      return { status: "corrupt", version: null };
    }
    return { status: "valid", version };
  } catch {
    return { status: "corrupt", version: null };
  }
}

function createInitialState(enabled: boolean): InstallerUpdateState {
  return {
    enabled,
    status: enabled ? "idle" : "disabled",
    installedVersion: null,
    availableVersion: null,
    markerStatus: "missing",
    checkedAt: null,
    message: enabled ? null : "Installer updates are only available in packaged builds.",
    errorContext: null,
    canRetry: false,
  };
}

function safeMessage(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("TritonAI Installer updates are not")) {
    return error.message;
  }
  if (error instanceof Error && error.message.startsWith("The stable TritonAI Installer release")) {
    return error.message;
  }
  if (
    error instanceof Error &&
    error.message === "No stable TritonAI Installer release is available."
  ) {
    return error.message;
  }
  return "Could not check for TritonAI Installer updates. Check your network connection and try again.";
}

export interface InstallerUpdateControllerOptions {
  readonly enabled: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly readMarker: () => Promise<InstallerVersionMarkerReadResult>;
  readonly fetchRelease: () => Promise<unknown>;
  readonly openExternal: (url: string) => Promise<boolean>;
  readonly nowIso?: () => string;
  readonly onState?: (state: InstallerUpdateState) => void | Promise<void>;
}

export function createInstallerUpdateController(options: InstallerUpdateControllerOptions) {
  let state = createInitialState(options.enabled);
  let selectedAsset: InstallerReleaseAsset | null = null;
  let checkInFlight = false;
  let openInFlight = false;
  const nowIso = options.nowIso ?? (() => DateTime.formatIso(DateTime.nowUnsafe()));

  const setState = async (next: InstallerUpdateState) => {
    state = next;
    try {
      await options.onState?.(state);
    } catch {
      // A renderer closing during a state broadcast must not fail the update operation.
    }
  };

  const check = async (): Promise<InstallerUpdateCheckResult> => {
    if (!state.enabled || checkInFlight || openInFlight) {
      return { checked: false, state };
    }
    checkInFlight = true;
    await setState({
      ...state,
      status: "checking",
      message: null,
      errorContext: null,
      canRetry: false,
    });

    try {
      // Resolve support before making a network request.
      expectedInstallerAssetName("0.0.0", options.platform, options.arch);
      const [rawRelease, marker] = await Promise.all([
        options.fetchRelease(),
        options.readMarker(),
      ]);
      const release = parseStableInstallerRelease(rawRelease);
      selectedAsset = selectInstallerReleaseAsset(release, options.platform, options.arch);
      const checkedAt = nowIso();
      const hasUpdate =
        marker.status !== "valid" ||
        marker.version === null ||
        compareInstallerVersions(release.version, marker.version) > 0;

      await setState({
        enabled: true,
        status: hasUpdate ? "available" : "up-to-date",
        installedVersion: marker.version,
        availableVersion: hasUpdate ? release.version : null,
        markerStatus: marker.status,
        checkedAt,
        message:
          marker.status === "valid"
            ? null
            : marker.status === "missing"
              ? "No installer version record was found. Run the latest full installer to update Harness, Codex, and managed skills."
              : "The installer version record could not be read. Run the latest full installer to repair and update Harness, Codex, and managed skills.",
        errorContext: null,
        canRetry: false,
      });
      return { checked: true, state };
    } catch (error) {
      selectedAsset = null;
      const message = safeMessage(error);
      const canRetry = !message.startsWith("TritonAI Installer updates are not available for");
      await setState({
        ...state,
        status: "error",
        availableVersion: null,
        checkedAt: nowIso(),
        message,
        errorContext: "check",
        canRetry,
      });
      return { checked: true, state };
    } finally {
      checkInFlight = false;
    }
  };

  const open = async (): Promise<InstallerUpdateActionResult> => {
    if (
      !state.enabled ||
      openInFlight ||
      checkInFlight ||
      selectedAsset === null ||
      (state.status !== "available" && state.errorContext !== "open")
    ) {
      return { accepted: false, completed: false, state };
    }

    openInFlight = true;
    const availableState = state;
    await setState({
      ...state,
      status: "opening",
      message: null,
      errorContext: null,
      canRetry: false,
    });
    try {
      const opened = await options.openExternal(selectedAsset.url);
      if (!opened) {
        throw new Error("open failed");
      }
      await setState({
        ...availableState,
        status: "available",
        message:
          "The full TritonAI Installer download was opened. Run it to update Harness, Codex, and managed skills.",
        errorContext: null,
        canRetry: false,
      });
      return { accepted: true, completed: true, state };
    } catch {
      await setState({
        ...availableState,
        status: "error",
        message:
          "Could not open the full TritonAI Installer download. Check your default browser and try again.",
        errorContext: "open",
        canRetry: true,
      });
      return { accepted: true, completed: false, state };
    } finally {
      openInFlight = false;
    }
  };

  return {
    getState: () => state,
    check,
    open,
  };
}

export class InstallerUpdates extends Context.Service<
  InstallerUpdates,
  {
    readonly getState: Effect.Effect<InstallerUpdateState>;
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
    readonly check: Effect.Effect<InstallerUpdateCheckResult>;
    readonly open: Effect.Effect<InstallerUpdateActionResult>;
  }
>()("@t3tools/desktop/updates/InstallerUpdates") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  const markerPath = environment.path.join(
    environment.homeDirectory,
    ...INSTALLER_VERSION_MARKER_RELATIVE_PATH,
  );
  const releaseRequest = HttpClientRequest.get(GITHUB_RELEASE_URL).pipe(
    HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
    HttpClientRequest.setHeader("user-agent", "TritonAI-Harness"),
    HttpClientRequest.setHeader("x-github-api-version", "2022-11-28"),
  );
  const fetchRelease = httpClient.execute(releaseRequest).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(readLimitedReleaseText),
    Effect.timeout("15 seconds"),
    Effect.mapError((cause) => new InstallerReleaseFetchError({ cause })),
    Effect.flatMap((raw) =>
      decodeUnknownJson(raw).pipe(
        Effect.mapError((cause) => new InstallerReleaseFetchError({ cause })),
      ),
    ),
  );
  const readMarker = Effect.gen(function* () {
    const markerExists = yield* fileSystem
      .exists(markerPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!markerExists) return parseInstallerVersionMarker(null);
    const markerInfo = yield* fileSystem.stat(markerPath).pipe(Effect.option);
    if (Option.isNone(markerInfo) || Number(markerInfo.value.size) > MAX_MARKER_BYTES) {
      return { status: "corrupt", version: null } as const;
    }
    const raw = yield* fileSystem.readFileString(markerPath, "utf8").pipe(Effect.option);
    return Option.match(raw, {
      onNone: () => ({ status: "corrupt", version: null }) as const,
      onSome: parseInstallerVersionMarker,
    });
  });
  const controller = createInstallerUpdateController({
    enabled: environment.isPackaged,
    platform: environment.platform,
    arch: environment.runtimeInfo.hostArch,
    readMarker: () => runPromise(readMarker),
    fetchRelease: () => runPromise(fetchRelease),
    openExternal: (url) => runPromise(electronShell.openExternal(url)),
    onState: (state) =>
      runPromise(electronWindow.sendAll(IpcChannels.INSTALLER_UPDATE_STATE_CHANNEL, state)),
  });

  return InstallerUpdates.of({
    getState: Effect.sync(controller.getState),
    configure: Effect.gen(function* () {
      if (!controller.getState().enabled) return;
      yield* Effect.promise(controller.check).pipe(Effect.forkScoped);
      yield* Effect.sleep(INSTALLER_UPDATE_POLL_INTERVAL).pipe(
        Effect.andThen(Effect.promise(controller.check)),
        Effect.forever,
        Effect.forkScoped,
      );
    }),
    check: Effect.promise(controller.check),
    open: Effect.promise(controller.open),
  });
});

export const layer = Layer.effect(InstallerUpdates, make);
