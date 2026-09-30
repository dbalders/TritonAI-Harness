import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A local calendar day, `YYYY-MM-DD`. */
export const MemoryDay = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u));
export type MemoryDay = typeof MemoryDay.Type;

export const ServerMemorySummarizerState = Schema.Literals([
  "disabled",
  "idle",
  "summarizing",
  "error",
]);
export type ServerMemorySummarizerState = typeof ServerMemorySummarizerState.Type;

export const ServerMemorySyncState = Schema.Literals([
  /** Sync is turned off. */
  "off",
  /** This build has no Microsoft sign-in configuration. */
  "unavailable",
  /** Sync is on but needs the user to sign in again. */
  "signed-out",
  "syncing",
  "idle",
  "error",
]);
export type ServerMemorySyncState = typeof ServerMemorySyncState.Type;

/** OneDrive sync of the memory vault between the user's computers. */
export const ServerMemorySyncStatus = Schema.Struct({
  state: ServerMemorySyncState,
  /** The signed-in Microsoft account, such as `user@ucsd.edu`. */
  account: Schema.NullOr(TrimmedNonEmptyString),
  /** The OneDrive folder the vault syncs with. */
  cloudFolder: TrimmedNonEmptyString,
  lastSyncedAt: Schema.NullOr(Schema.String),
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerMemorySyncStatus = typeof ServerMemorySyncStatus.Type;

/**
 * What the Memory settings row shows: where this machine keeps memory and how
 * far the daily summarizer has caught up.
 */
export const ServerMemoryStatus = Schema.Struct({
  enabled: Schema.Boolean,
  /** Parent folder for every memory system on this machine. */
  directoryPath: TrimmedNonEmptyString,
  /** The general vault: daily notes, project notes, and the inbox. */
  generalDirectoryPath: TrimmedNonEmptyString,
  state: ServerMemorySummarizerState,
  lastSummarizedDay: Schema.NullOr(MemoryDay),
  message: Schema.NullOr(TrimmedNonEmptyString),
  sync: ServerMemorySyncStatus,
});
export type ServerMemoryStatus = typeof ServerMemoryStatus.Type;

/**
 * Turning sync on either works right away, because a Microsoft sign-in is
 * already saved or the Microsoft 365 plugin is connected, or needs the user to
 * enter a code at Microsoft's sign-in page.
 */
export const ServerMemorySyncStartResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("connected") }),
  Schema.Struct({
    kind: Schema.Literal("device_code"),
    flowId: TrimmedNonEmptyString,
    userCode: TrimmedNonEmptyString,
    verificationUri: TrimmedNonEmptyString,
    expiresAt: Schema.String,
    intervalSeconds: Schema.Number,
  }),
]);
export type ServerMemorySyncStartResult = typeof ServerMemorySyncStartResult.Type;

export const ServerMemorySyncPollInput = Schema.Struct({ flowId: TrimmedNonEmptyString });
export type ServerMemorySyncPollInput = typeof ServerMemorySyncPollInput.Type;

export const ServerMemorySyncPollResult = Schema.Struct({
  state: Schema.Literals(["pending", "connected", "expired", "failed"]),
  retryAfterSeconds: Schema.NullOr(Schema.Number),
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerMemorySyncPollResult = typeof ServerMemorySyncPollResult.Type;

export class ServerMemorySyncError extends Schema.TaggedError<ServerMemorySyncError>()(
  "ServerMemorySyncError",
  { message: TrimmedNonEmptyString },
) {}
