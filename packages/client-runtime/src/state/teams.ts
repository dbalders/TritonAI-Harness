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

/**
 * Owned by one account/environment and shared by the views that show it. Closing or changing
 * accounts discards all team data.
 */
export function createTeamsController(
  execute: (command: TeamCommand) => Promise<TeamsResult>,
  now: () => number = Date.now,
) {
  let state: TeamsState = { result: null, busy: false, error: null };
  let generation = 0;
  let active = false;
  let users = 0;
  let listedAt = -Infinity;
  const listeners = new Set<() => void>();
  const publish = (value: Partial<TeamsState>) => {
    state = { ...state, ...value };
    for (const listener of listeners) listener();
  };
  const run = async (command: TeamCommand): Promise<boolean> => {
    if (!active || state.busy) return false;
    const request = ++generation;
    if (command.action === "list") listedAt = now();
    publish({ busy: true, error: null });
    try {
      const result = await execute(command);
      if (!active || generation !== request) return false;
      publish({ result, busy: false });
      return true;
    } catch (error) {
      if (active && generation === request)
        publish({
          // Keep the mounted editor through retryable failures; confirmed access
          // failures and account teardown still discard all private state.
          result:
            error instanceof Error &&
            "code" in error &&
            ["unavailable", "conflict", "invalid_request"].includes(String(error.code))
              ? state.result
              : null,
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
    /** Each view activates while it shows the account, which rereads the list. */
    activate() {
      if (users++ === 0) {
        active = true;
        publish({ result: null, busy: false, error: null });
      }
      void run({ action: "list" });
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        generation++;
        if (--users > 0) {
          // The views left only need the list; the open team, any new code, and late replies
          // close with the page.
          publish({
            result: state.result && { ...state.result, team: null, invitationCode: null },
            busy: false,
          });
          return;
        }
        active = false;
        publish({ result: null, busy: false, error: null });
      };
    },
    /**
     * Rereads the list if it is older than `maxAgeMs` and no team is open, so an indicator can
     * follow existing account checks instead of its own polling.
     */
    refreshList(maxAgeMs: number) {
      if (state.result?.team || now() - listedAt < maxAgeMs) return Promise.resolve(false);
      return run({ action: "list" });
    },
    run,
  };
}

export type TeamsController = ReturnType<typeof createTeamsController>;

/** Invitations waiting for the signed-in account; none while teams are unknown or unavailable. */
export const pendingTeamInvitationCount = (state: TeamsState) =>
  state.result?.invitations.length ?? 0;

/** One controller per key, so every view of an account shares one list and its requests. */
export function createTeamsControllerCache() {
  const controllers = new Map<string, TeamsController>();
  return (key: string, execute: (command: TeamCommand) => Promise<TeamsResult>) => {
    let controller = controllers.get(key);
    if (!controller) {
      controller = createTeamsController(execute);
      controllers.set(key, controller);
    }
    return controller;
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
  // A history read leaves the open document and the list as they were.
  if (command.action === "list-versions" || command.action === "read-version")
    return { ...next, document: previous.document, files: previous.files };
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
