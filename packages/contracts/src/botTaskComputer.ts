import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Whether this computer runs approved TritonAI Bot Harness tasks. Every signed-in
 * Harness can chat with the bot; only the one the owner allowed claims tasks.
 */
export const ServerBotTaskComputerState = Schema.Literals([
  /** This computer is not set to run tasks. */
  "off",
  /** Checking in and waiting for approved work. */
  "idle",
  "running",
  /** The owner allowed another computer; held results are still delivered. */
  "replaced",
  /** The last check-in or delivery failed; it retries on its own. */
  "error",
]);
export type ServerBotTaskComputerState = typeof ServerBotTaskComputerState.Type;

export const ServerBotTaskComputerTask = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  threadId: Schema.NullOr(TrimmedNonEmptyString),
  startedAt: Schema.String,
});
export type ServerBotTaskComputerTask = typeof ServerBotTaskComputerTask.Type;

export const ServerBotTaskComputerStatus = Schema.Struct({
  state: ServerBotTaskComputerState,
  /** Stable ID the bot uses to recognize this computer. */
  deviceId: TrimmedNonEmptyString,
  deviceName: TrimmedNonEmptyString,
  /** The bot this computer runs tasks for, while allowed. */
  apiUrl: Schema.NullOr(TrimmedNonEmptyString),
  userId: Schema.NullOr(TrimmedNonEmptyString),
  /** Project whose folder and defaults new task threads use. */
  projectId: Schema.NullOr(TrimmedNonEmptyString),
  currentTask: Schema.NullOr(ServerBotTaskComputerTask),
  lastCheckInAt: Schema.NullOr(Schema.String),
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerBotTaskComputerStatus = typeof ServerBotTaskComputerStatus.Type;

/** The owner session is used once to pair and is never stored. */
export const ServerBotTaskComputerAllowInput = Schema.Struct({
  apiUrl: TrimmedNonEmptyString,
  ownerToken: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
});
export type ServerBotTaskComputerAllowInput = typeof ServerBotTaskComputerAllowInput.Type;

/** Without an owner session the computer stops locally and the bot shows it offline. */
export const ServerBotTaskComputerStopInput = Schema.Struct({
  ownerToken: Schema.NullOr(TrimmedNonEmptyString),
  apiUrl: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerBotTaskComputerStopInput = typeof ServerBotTaskComputerStopInput.Type;

export const ServerBotTaskComputerProjectInput = Schema.Struct({
  projectId: TrimmedNonEmptyString,
});
export type ServerBotTaskComputerProjectInput = typeof ServerBotTaskComputerProjectInput.Type;

export class ServerBotTaskComputerError extends Schema.TaggedError<ServerBotTaskComputerError>()(
  "ServerBotTaskComputerError",
  { message: TrimmedNonEmptyString },
) {}
