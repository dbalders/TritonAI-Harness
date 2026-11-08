import * as Schema from "effect/Schema";
import { PortSchema, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { DesktopComputerUseStateSchema } from "./ipc.ts";

export const DesktopMcpServerConfiguration = Schema.Struct({
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String),
  environment: Schema.Record(Schema.String, Schema.String),
});
export type DesktopMcpServerConfiguration = typeof DesktopMcpServerConfiguration.Type;

// A supervisor must not restart a server refused by the state-directory owner.
export const SERVER_EXIT_CODE_STATE_DIR_OWNED = 78;

export const DesktopBackendBootstrap = Schema.Struct({
  // The first key encrypts new server-secret envelopes. Any remaining keys
  // are rotation fallbacks and are used only to decrypt and lazily re-encrypt
  // existing values. Desktop sends this through the inherited bootstrap pipe,
  // never argv or the process environment.
  secretStoreKeys: Schema.Array(Schema.String),
  // Keyed fingerprints captured before the first encrypted write are the only
  // values the server may recognize as legacy plaintext.
  legacySecretFingerprints: Schema.Record(Schema.String, Schema.String),
  mode: Schema.Literal("desktop"),
  noBrowser: Schema.Boolean,
  port: PortSchema,
  // Omitted when the desktop launches the backend inside WSL, since the
  // Windows-side baseDir maps to /mnt/c/... and the Linux side should use its
  // own home directory instead.
  t3Home: Schema.optional(Schema.String),
  host: Schema.String,
  desktopBootstrapToken: Schema.String,
  // Present when the desktop rotates the renderer's bootstrap token: the
  // backend derives the accepted tokens from this secret instead of trusting
  // `desktopBootstrapToken` for its whole run. See
  // `@t3tools/shared/desktopBootstrapToken`.
  desktopBootstrapSecret: Schema.optionalKey(Schema.String),
  // Set only when the desktop already merged the user's shell environment into
  // the environment it hands this backend. Absent means the backend hydrates
  // PATH itself, which WSL and older desktops rely on.
  shellEnvironmentPrepared: Schema.optionalKey(Schema.Boolean),
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: PortSchema,
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
  otlpLogsUrl: Schema.optional(Schema.String),
  desktopTelemetryFd: Schema.optionalKey(PositiveInt),
  desktopTelemetryControlFd: Schema.optionalKey(PositiveInt),
  desktopBrowserFd: Schema.optionalKey(PositiveInt),
  desktopBrowserControlFd: Schema.optionalKey(PositiveInt),
  resourceMonitorPath: Schema.optionalKey(TrimmedNonEmptyString),
  // Local-only process details supplied over the inherited bootstrap pipe.
  // This is intentionally omitted for WSL and non-desktop server launches.
  computerUseMcp: Schema.optionalKey(DesktopMcpServerConfiguration),
  computerUseState: Schema.optionalKey(DesktopComputerUseStateSchema),
});

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;

/** Written to `<t3Home>/runtime` just before the desktop app stops its
    backend to install an update. The updated app starts a new backend right
    away, so a backend that sees a fresh marker at shutdown keeps its managed
    tunnel. */
export const DESKTOP_UPDATE_RESTART_MARKER_FILE = "desktop-update-restart";
