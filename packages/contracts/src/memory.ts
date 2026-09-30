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
});
export type ServerMemoryStatus = typeof ServerMemoryStatus.Type;
