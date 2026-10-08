import type {
  TeamCommand,
  TeamsResult,
  TeamStorageCommand,
  TeamStorageStatus,
} from "@t3tools/contracts";

export interface TeamsState {
  readonly result: TeamsResult | null;
  readonly busy: boolean;
  readonly error: string | null;
}

/** Owned by one visible account/environment. Closing or changing accounts discards all team data. */
export function createTeamsController(execute: (command: TeamCommand) => Promise<TeamsResult>) {
  let state: TeamsState = { result: null, busy: false, error: null };
  let generation = 0;
  let active = false;
  const listeners = new Set<() => void>();
  const publish = (value: Partial<TeamsState>) => {
    state = { ...state, ...value };
    for (const listener of listeners) listener();
  };
  const run = async (command: TeamCommand): Promise<boolean> => {
    if (!active || state.busy) return false;
    const request = ++generation;
    publish({ busy: true, error: null });
    try {
      const result = await execute(command);
      if (!active || generation !== request) return false;
      publish({ result, busy: false });
      return true;
    } catch (error) {
      if (active && generation === request)
        publish({
          result: null,
          busy: false,
          error: error instanceof Error ? error.message : "Teams could not be reached.",
        });
      return false;
    }
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    activate() {
      active = true;
      publish({ result: null, busy: false, error: null });
      void run({ action: "list" });
      return () => {
        active = false;
        generation++;
        publish({ result: null, busy: false, error: null });
      };
    },
    run,
  };
}

/** Polls and file-list refreshes must not replace an open document and discard its draft. */
export function mergeTeamStorageResult(
  previous: TeamStorageStatus | null,
  next: TeamStorageStatus,
  command: TeamStorageCommand,
): TeamStorageStatus {
  if (
    next.status === "pending" &&
    previous?.status === "pending" &&
    next.flowId === previous.flowId
  ) {
    return {
      ...next,
      verificationUri: next.verificationUri ?? previous.verificationUri,
      userCode: next.userCode ?? previous.userCode,
      expiresAt: next.expiresAt ?? previous.expiresAt,
    };
  }
  if (next.status !== "connected" || previous?.status !== "connected") return next;
  if (command.action === "list-files" || command.action === "status") {
    return {
      ...next,
      document: previous.document,
      files: command.action === "list-files" ? next.files : previous.files,
    };
  }
  if (["publish", "read-file", "update-file", "delete-file"].includes(command.action)) {
    return {
      ...next,
      files:
        command.action === "delete-file"
          ? previous.files.filter((file) => file.path !== command.path)
          : previous.files,
    };
  }
  return next;
}
