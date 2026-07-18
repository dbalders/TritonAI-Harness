import * as Schema from "effect/Schema";

import { PortSchema } from "./baseSchemas.ts";

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
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: PortSchema,
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
});

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;
