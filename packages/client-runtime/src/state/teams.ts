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
  readonly creation: {
    readonly name: string;
    readonly phase: "creating" | "checking" | "unconfirmed";
  } | null;
}

/**
 * Owned by one account/environment and shared by the views that show it. Closing or changing
 * accounts discards all team data.
 */
export function createTeamsController(
  execute: (command: TeamCommand) => Promise<TeamsResult>,
  // @effect-diagnostics-next-line globalDate:off -- UI recovery uses the browser clock, injectable in tests.
  now: () => number = () => Date.now(),
) {
  let state: TeamsState = { result: null, busy: false, error: null, creation: null };
  let generation = 0;
  let active = false;
  let users = 0;
  let workspaces = 0;
  let pendingAction: TeamCommand["action"] | null = null;
  let listedAt = -Infinity;
  let pendingCreation: {
    command: Extract<TeamCommand, { action: "create" }>;
    teamId: string | null;
  } | null = null;
  let cancelCheck: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const publish = (value: Partial<TeamsState>) => {
    state = { ...state, ...value };
    for (const listener of listeners) listener();
  };
  const failed = (error: unknown) => {
    pendingAction = null;
    pendingCreation = null;
    publish({
      // A transport failure does not revoke the account's last confirmed data.
      result:
        error instanceof Error &&
        "code" in error &&
        ["unavailable", "conflict", "invalid_request"].includes(String(error.code))
          ? state.result
          : null,
      busy: false,
      creation: null,
      error: error instanceof Error ? error.message : "Teams could not be reached.",
    });
  };
  const checkCreation = async (request: number): Promise<boolean> => {
    const current = () => active && generation === request;
    const pending = pendingCreation;
    if (!pending || !current()) return false;
    const deadline = now() + 60_000;
    while (current() && now() < deadline) {
      try {
        // Create is idempotent for this exact request ID. Its replay identifies the
        // team even when the first response was lost; never match a team by name.
        const result = await execute(
          pending.teamId ? { action: "get", teamId: pending.teamId } : pending.command,
        );
        if (!active || generation !== request) return false;
        if (result.team) {
          pending.teamId = result.team.id;
          if (result.team.state !== "provisioning") {
            pendingCreation = null;
            pendingAction = null;
            publish({ result, busy: false, creation: null, error: null });
            return true;
          }
          publish({ result });
        }
      } catch (error) {
        if (!active || generation !== request) return false;
        if (!(error instanceof Error && "code" in error && error.code === "unavailable")) {
          failed(error);
          return false;
        }
      }
      if (!current()) return false;
      publish({ creation: { name: pending.command.name, phase: "checking" } });
      await new Promise<void>((resolve) => {
        // @effect-diagnostics-next-line globalTimers:off -- Canceled with the owning browser account/view.
        const timer = setTimeout(
          () => {
            cancelCheck = null;
            resolve();
          },
          Math.min(2_000, deadline - now()),
        );
        cancelCheck = () => {
          clearTimeout(timer);
          cancelCheck = null;
          resolve();
        };
      });
    }
    if (current()) {
      pendingAction = null;
      publish({ busy: false, creation: { name: pending.command.name, phase: "unconfirmed" } });
    }
    return false;
  };
  const run = async (command: TeamCommand): Promise<boolean> => {
    if (!active || state.busy) return false;
    // While an earlier creation is unconfirmed, only checking its exact request
    // may proceed. A new request ID could create a duplicate after a lost reply.
    if (pendingCreation && command.action !== "list") return false;
    const request = ++generation;
    pendingAction = pendingCreation || command.action === "create" ? "create" : command.action;
    if (command.action === "create") pendingCreation = { command, teamId: null };
    if (pendingCreation) {
      publish({
        busy: true,
        error: null,
        creation: {
          name: pendingCreation.command.name,
          phase: command.action === "create" ? "creating" : "checking",
        },
      });
      return checkCreation(request);
    }
    if (command.action === "list") listedAt = now();
    publish({ busy: true, error: null });
    try {
      const result = await execute(command);
      if (!active || generation !== request) return false;
      pendingAction = null;
      publish({ result, busy: false });
      return true;
    } catch (error) {
      if (active && generation === request) failed(error);
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
    /** Indicators share the list without owning the workspace's open team or requests. */
    activate(view: "workspace" | "indicator" = "workspace") {
      if (users++ === 0) {
        active = true;
        publish({ result: null, busy: false, error: null, creation: null });
      }
      if (view === "workspace") workspaces++;
      if (
        state.result === null ||
        (view === "workspace" && state.creation?.phase === "unconfirmed")
      )
        void run({ action: "list" });
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        if (view === "workspace") workspaces--;
        if (--users > 0) {
          if (view === "workspace" && workspaces === 0) {
            // Only the last workspace closes private team details. A pending list still
            // belongs to the remaining indicators; their lifecycle never cancels a command.
            const cancelRequest = pendingAction !== null && pendingAction !== "list";
            if (cancelRequest) {
              generation++;
              pendingAction = null;
              cancelCheck?.();
            }
            publish({
              result: state.result && { ...state.result, team: null, invitationCode: null },
              ...(cancelRequest ? { busy: false } : {}),
              creation: pendingCreation
                ? { name: pendingCreation.command.name, phase: "unconfirmed" }
                : null,
            });
          }
          return;
        }
        generation++;
        pendingAction = null;
        cancelCheck?.();
        active = false;
        pendingCreation = null;
        publish({ result: null, busy: false, error: null, creation: null });
      };
    },
    /**
     * Rereads the list if it is older than `maxAgeMs` and no team is open, so an indicator can
     * follow existing account checks instead of its own polling.
     */
    refreshList(maxAgeMs: number) {
      if (state.creation || state.result?.team || now() - listedAt < maxAgeMs)
        return Promise.resolve(false);
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
  if (
    command.action === "list-files" ||
    command.action === "status" ||
    command.action === "connect" ||
    command.action === "poll"
  ) {
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
