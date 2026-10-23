import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { TeamsError, type TeamsResult, type TeamStorageStatus } from "@t3tools/contracts";
import {
  createTeamsController,
  createTeamsControllerCache,
  mergeTeamStorageResult,
  pendingTeamInvitationCount,
} from "./teams.ts";
const empty: TeamsResult = { teams: [], invitations: [], team: null, invitationCode: null };
const openedTeam: NonNullable<TeamsResult["team"]> = {
  id: "team",
  reference: "T-TEST",
  name: "Synthetic",
  role: "member",
  canManage: false,
  state: "ready",
  revision: 1,
  members: [],
  invitations: [],
  storage: null,
};
describe("team creation recovery", () => {
  const create = {
    action: "create",
    name: "Finance",
    requestId: "11111111-2222-4333-8444-555555555555",
  } as const;
  const unavailable = () => new TeamsError({ code: "unavailable", message: "Request timed out" });
  const created = (state: "provisioning" | "ready" | "needs-attention"): TeamsResult => ({
    ...empty,
    teams: [{ ...openedTeam, name: create.name, state }],
    team: { ...openedTeam, name: create.name, state },
  });
  afterEach(() => vi.useRealTimers());

  it("keeps creation running when a sidebar indicator closes", async () => {
    const pending = Promise.withResolvers<TeamsResult>();
    const execute = vi.fn().mockResolvedValueOnce(empty).mockReturnValueOnce(pending.promise);
    const controller = createTeamsController(execute);
    const stopPage = controller.activate();
    await Promise.resolve();
    const stopIndicator = controller.activate("indicator");
    const completion = controller.run(create);
    stopIndicator();
    expect(controller.getSnapshot()).toMatchObject({ busy: true, creation: { phase: "creating" } });
    pending.resolve(created("ready"));
    expect(await completion).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      busy: false,
      creation: null,
      result: { team: { state: "ready" } },
    });
    stopPage();
  });

  it("keeps creation pending after a lost response, reuses its request ID, and follows that team to ready", async () => {
    vi.useFakeTimers();
    const execute = vi
      .fn()
      .mockResolvedValueOnce(empty)
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce(created("provisioning"))
      .mockResolvedValueOnce(created("ready"));
    const controller = createTeamsController(execute);
    const stop = controller.activate();
    await Promise.resolve();
    const states: ReturnType<typeof controller.getSnapshot>[] = [];
    controller.subscribe(() => states.push(controller.getSnapshot()));
    const completion = controller.run(create);
    expect(controller.getSnapshot()).toMatchObject({
      busy: true,
      creation: { name: "Finance", phase: "creating" },
    });
    expect(await controller.run(create)).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.getSnapshot()).toMatchObject({
      busy: true,
      error: null,
      creation: { phase: "checking" },
      result: { team: { state: "provisioning" } },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await completion).toBe(true);
    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      { action: "list" },
      create,
      create,
      { action: "get", teamId: openedTeam.id },
    ]);
    expect(states.every((state) => state.error === null)).toBe(true);
    expect(states.slice(0, -1).every((state) => state.busy)).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      busy: false,
      creation: null,
      result: created("ready"),
    });
    stop();
  });

  it("stops automatic checks after a minute without calling the creation failed or allowing duplicates", async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockResolvedValueOnce(empty).mockRejectedValue(unavailable());
    const controller = createTeamsController(execute);
    const stop = controller.activate();
    await Promise.resolve();
    const completion = controller.run(create);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await completion).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      busy: false,
      error: null,
      creation: { name: "Finance", phase: "unconfirmed" },
    });
    const calls = execute.mock.calls.length;
    expect(await controller.run({ ...create, requestId: "another-request" })).toBe(false);
    expect(execute).toHaveBeenCalledTimes(calls);
    execute.mockResolvedValueOnce(created("ready"));
    expect(await controller.run({ action: "list" })).toBe(true);
    expect(execute.mock.calls.at(-1)?.[0]).toEqual(create);
    expect(controller.getSnapshot().creation).toBeNull();
    stop();
  });

  it("cancels scheduled checks on sign-out and discards a late creation result", async () => {
    vi.useFakeTimers();
    const late = Promise.withResolvers<TeamsResult>();
    const execute = vi
      .fn()
      .mockResolvedValueOnce(empty)
      .mockRejectedValueOnce(unavailable())
      .mockReturnValueOnce(late.promise);
    const controller = createTeamsController(execute);
    const stop = controller.activate();
    await Promise.resolve();
    const completion = controller.run(create);
    await vi.advanceTimersByTimeAsync(2_000);
    stop();
    late.resolve(created("ready"));
    expect(await completion).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(controller.getSnapshot()).toMatchObject({
      result: null,
      busy: false,
      creation: null,
      error: null,
    });
  });

  it("shows a confirmed validation failure without retrying it", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce(empty)
      .mockRejectedValueOnce(
        new TeamsError({ code: "invalid_request", message: "Choose another name" }),
      );
    const controller = createTeamsController(execute);
    const stop = controller.activate();
    await Promise.resolve();
    expect(await controller.run(create)).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      busy: false,
      creation: null,
      error: "Choose another name",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    stop();
  });

  it("keeps a confirmed team needing attention distinct from a transport failure", async () => {
    vi.useFakeTimers();
    const execute = vi
      .fn()
      .mockResolvedValueOnce(empty)
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce(created("needs-attention"));
    const controller = createTeamsController(execute);
    const stop = controller.activate();
    await Promise.resolve();
    const completion = controller.run(create);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await completion).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      busy: false,
      error: null,
      creation: null,
      result: { team: { state: "needs-attention" } },
    });
    stop();
  });

  it("cancels the recovery timer when the account closes", async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockResolvedValueOnce(empty).mockRejectedValueOnce(unavailable());
    const controller = createTeamsController(execute);
    const stop = controller.activate();
    await Promise.resolve();
    const completion = controller.run(create);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    expect(await completion).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resumes the same pending creation when the page reopens while the sidebar keeps the account active", async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockResolvedValue(empty);
    const controller = createTeamsController(execute);
    const stopSidebar = controller.activate("indicator");
    await Promise.resolve();
    const stopPage = controller.activate();
    await Promise.resolve();
    execute.mockRejectedValueOnce(unavailable());
    const completion = controller.run(create);
    await vi.advanceTimersByTimeAsync(0);
    stopPage();
    expect(await completion).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      busy: false,
      creation: { phase: "unconfirmed" },
    });
    expect(await controller.refreshList(0)).toBe(false);
    execute.mockResolvedValueOnce(created("ready"));
    const stopReopened = controller.activate();
    await Promise.resolve();
    expect(execute.mock.calls.at(-1)?.[0]).toEqual(create);
    expect(controller.getSnapshot()).toMatchObject({
      creation: null,
      result: { team: { state: "ready" } },
    });
    stopReopened();
    stopSidebar();
  });
});
describe("team account lifecycle", () => {
  it("retains the selected team through a temporary refresh failure and clears it on revocation", async () => {
    const pending = Promise.withResolvers<TeamsResult>();
    const opened: TeamsResult = {
      ...empty,
      team: {
        id: "team",
        reference: "T-TEST",
        name: "Synthetic",
        role: "member",
        canManage: false,
        state: "ready",
        revision: 1,
        members: [],
        invitations: [],
        storage: { tenantId: "tenant", siteId: "site", driveId: "drive", folderId: "folder" },
      },
    };
    const execute = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(opened)
      .mockRejectedValueOnce(new TeamsError({ code: "unavailable", message: "Try again" }))
      .mockRejectedValueOnce(new TeamsError({ code: "not_found", message: "Team unavailable" }));
    const controller = createTeamsController(execute);
    controller.activate();
    pending.resolve(empty);
    await pending.promise;
    await controller.run({ action: "get", teamId: "team" });
    await controller.run({ action: "get", teamId: "team" });
    expect(controller.getSnapshot().result).toBe(opened);
    expect(controller.getSnapshot().error).toBe("Try again");
    await controller.run({ action: "get", teamId: "team" });
    expect(controller.getSnapshot().result).toBeNull();
  });
  it("discards a late response after sign out and cannot repopulate private data", async () => {
    const pending = Promise.withResolvers<TeamsResult>();
    const controller = createTeamsController(() => pending.promise);
    const stop = controller.activate();
    stop();
    pending.resolve({ ...empty, invitationCode: "sensitive" });
    await pending.promise;
    expect(controller.getSnapshot()).toEqual({
      result: null,
      busy: false,
      error: null,
      creation: null,
    });
  });
  it("serializes requests and clears stale data after access errors", async () => {
    const pending = Promise.withResolvers<TeamsResult>();
    const execute = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new Error("Access revoked"));
    const controller = createTeamsController(execute);
    controller.activate();
    expect(await controller.run({ action: "list" })).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    pending.resolve(empty);
    await pending.promise;
    expect(controller.getSnapshot().result).toEqual(empty);
    await controller.run({ action: "list" });
    expect(controller.getSnapshot()).toEqual({
      result: null,
      busy: false,
      error: "Access revoked",
      creation: null,
    });
  });
});

describe("pending invitation count", () => {
  const invitation = (id: string) => ({
    id,
    teamId: "team",
    teamName: "Synthetic",
    teamReference: "T-TEST",
    email: "alice@ucsd.edu",
    role: "reader" as const,
    expiresAt: 4_102_444_800,
  });
  const invited = (...ids: string[]) => ({ ...empty, invitations: ids.map(invitation) });

  it("follows each answer and clears on sign out", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce(invited("a", "b"))
      .mockResolvedValueOnce(invited("b"))
      .mockResolvedValueOnce(invited());
    const controller = createTeamsController(execute);
    const count = () => pendingTeamInvitationCount(controller.getSnapshot());
    const stop = controller.activate();
    expect(count()).toBe(0);
    await vi.waitFor(() => expect(count()).toBe(2));
    await controller.run({ action: "decline", invitationId: "a" });
    expect(count()).toBe(1);
    await controller.run({ action: "accept-pending", invitationId: "b" });
    expect(count()).toBe(0);
    execute.mockResolvedValueOnce(invited("c"));
    await controller.run({ action: "list" });
    stop();
    expect(count()).toBe(0);
  });

  it("keeps each account's invitations to that account", async () => {
    const controllers = createTeamsControllerCache();
    const alice = controllers("env\nalice", async () => invited("a"));
    const stopAlice = alice.activate();
    await vi.waitFor(() => expect(pendingTeamInvitationCount(alice.getSnapshot())).toBe(1));
    stopAlice();
    const bob = controllers("env\nbob", async () => invited());
    bob.activate();
    expect(bob).not.toBe(alice);
    expect(pendingTeamInvitationCount(alice.getSnapshot())).toBe(0);
    await vi.waitFor(() => expect(bob.getSnapshot().result).toEqual(invited()));
    expect(controllers("env\nalice", async () => empty)).toBe(alice);
  });

  it("counts nothing when Teams is not configured", async () => {
    const controller = createTeamsController(async () => {
      throw new TeamsError({ code: "not_configured", message: "Not configured" });
    });
    controller.activate();
    await vi.waitFor(() => expect(controller.getSnapshot().error).toBe("Not configured"));
    expect(pendingTeamInvitationCount(controller.getSnapshot())).toBe(0);
  });

  it("shares one list between views and drops the open team when the page closes", async () => {
    const opened = {
      ...invited("a"),
      team: openedTeam,
      invitationCode: "triton-team:secret",
    };
    const execute = vi.fn().mockResolvedValueOnce(invited("a")).mockResolvedValueOnce(opened);
    const controller = createTeamsController(execute);
    const stopSidebar = controller.activate("indicator");
    await vi.waitFor(() => expect(controller.getSnapshot().busy).toBe(false));
    const stopPage = controller.activate();
    await vi.waitFor(() => expect(controller.getSnapshot().busy).toBe(false));
    await controller.run({ action: "get", teamId: "team" });
    const late = Promise.withResolvers<TeamsResult>();
    execute.mockReturnValueOnce(late.promise);
    void controller.run({ action: "get", teamId: "team" });
    stopPage();
    late.resolve(opened);
    await late.promise;
    expect(controller.getSnapshot().result).toEqual(invited("a"));
    expect(controller.getSnapshot().busy).toBe(false);
    expect(pendingTeamInvitationCount(controller.getSnapshot())).toBe(1);
    stopSidebar();
    expect(controller.getSnapshot().result).toBeNull();
  });

  it("keeps an open team and invitation code when an indicator mounts and unmounts", async () => {
    const opened = { ...invited("a"), team: openedTeam, invitationCode: "triton-team:secret" };
    const execute = vi.fn(async (): Promise<TeamsResult> => invited("a"));
    const controller = createTeamsController(execute);
    const stopPage = controller.activate();
    await vi.waitFor(() => expect(controller.getSnapshot().busy).toBe(false));
    execute.mockResolvedValueOnce(opened);
    await controller.run({ action: "get", teamId: "team" });

    const stopSidebar = controller.activate("indicator");
    expect(execute).toHaveBeenCalledTimes(2);
    stopSidebar();
    stopSidebar();
    expect(controller.getSnapshot()).toEqual({
      result: opened,
      busy: false,
      error: null,
      creation: null,
    });
    stopPage();
    expect(controller.getSnapshot().result).toBeNull();
  });

  it("accepts a confirmed membership reply when another view stops", async () => {
    const opened = { ...invited("a"), team: openedTeam };
    const execute = vi.fn(async (): Promise<TeamsResult> => invited("a"));
    const controller = createTeamsController(execute);
    const stopPage = controller.activate();
    const stopSidebar = controller.activate("indicator");
    await vi.waitFor(() => expect(controller.getSnapshot().busy).toBe(false));
    execute.mockResolvedValueOnce(opened);
    await controller.run({ action: "get", teamId: "team" });
    const pending = Promise.withResolvers<TeamsResult>();
    execute.mockReturnValueOnce(pending.promise);
    const result = controller.run({
      action: "invite",
      teamId: "team",
      email: "member@ucsd.edu",
      role: "member",
      revision: 1,
    });
    stopSidebar();
    expect(controller.getSnapshot().busy).toBe(true);
    const confirmed = { ...opened, invitationCode: "triton-team:new-code" };
    pending.resolve(confirmed);
    expect(await result).toBe(true);
    expect(controller.getSnapshot()).toEqual({
      result: confirmed,
      busy: false,
      error: null,
      creation: null,
    });
    stopPage();
  });

  it("keeps an indicator's pending list when the workspace leaves", async () => {
    const pending = Promise.withResolvers<TeamsResult>();
    const execute = vi.fn(() => pending.promise);
    const controller = createTeamsController(execute);
    const stopSidebar = controller.activate("indicator");
    const stopPage = controller.activate();
    stopPage();
    expect(controller.getSnapshot().busy).toBe(true);
    pending.resolve(invited("a"));
    await pending.promise;
    expect(pendingTeamInvitationCount(controller.getSnapshot())).toBe(1);
    expect(controller.getSnapshot().busy).toBe(false);
    stopSidebar();
  });

  it("retains the open team until the last workspace leaves", async () => {
    const opened = { ...invited("a"), team: openedTeam };
    const execute = vi.fn(async (): Promise<TeamsResult> => invited("a"));
    const controller = createTeamsController(execute);
    const stopSidebar = controller.activate("indicator");
    const stopFirstPage = controller.activate();
    const stopSecondPage = controller.activate();
    await vi.waitFor(() => expect(controller.getSnapshot().busy).toBe(false));
    execute.mockResolvedValueOnce(opened);
    await controller.run({ action: "get", teamId: "team" });
    stopFirstPage();
    expect(controller.getSnapshot().result).toBe(opened);
    stopSecondPage();
    expect(controller.getSnapshot().result).toEqual(invited("a"));
    stopSidebar();
  });

  it("refreshes on account checks only when stale and no team is open", async () => {
    let time = 0;
    const execute = vi.fn(async (): Promise<TeamsResult> => invited("a"));
    const controller = createTeamsController(execute, () => time);
    controller.activate();
    await vi.waitFor(() => expect(controller.getSnapshot().busy).toBe(false));
    time = 60_000;
    expect(await controller.refreshList(300_000)).toBe(false);
    time = 300_000;
    execute.mockResolvedValueOnce({ ...invited("a"), team: openedTeam });
    await controller.run({ action: "get", teamId: "team" });
    expect(await controller.refreshList(300_000)).toBe(false);
    execute.mockResolvedValueOnce(invited("a", "b"));
    await controller.run({ action: "list" });
    time = 600_000;
    execute.mockResolvedValueOnce(invited());
    expect(await controller.refreshList(300_000)).toBe(true);
    expect(pendingTeamInvitationCount(controller.getSnapshot())).toBe(0);
    expect(execute).toHaveBeenCalledTimes(4);
  });
});

it("preserves the open document and its draft identity through list and status refreshes", () => {
  const opened: TeamStorageStatus = {
    status: "connected",
    account: "synthetic",
    flowId: null,
    userCode: null,
    verificationUri: null,
    expiresAt: null,
    retryAfterSeconds: null,
    document: { path: "SOPs/example.md", etag: "v1", text: "Saved text" },
    files: [{ id: "old", path: "SOPs/example.md", etag: "v1", size: 10 }],
  };
  const refreshed = mergeTeamStorageResult(
    opened,
    { ...opened, document: null, files: [] },
    { action: "list-files", teamId: "team" },
  );
  expect(refreshed.document).toBe(opened.document);
  expect(refreshed.files).toEqual([]);
  const status = mergeTeamStorageResult(
    opened,
    { ...opened, document: null, files: [] },
    { action: "status", teamId: "team" },
  );
  expect(status.document).toBe(opened.document);
  expect(status.files).toBe(opened.files);
  const history = mergeTeamStorageResult(
    opened,
    { ...opened, document: null, files: [], history: { path: "SOPs/example.md", versions: [] } },
    { action: "list-versions", teamId: "team", path: "SOPs/example.md" },
  );
  expect(history.document).toBe(opened.document);
  expect(history.files).toBe(opened.files);
  expect(history.history?.versions).toEqual([]);
  const disconnected = mergeTeamStorageResult(
    opened,
    { ...opened, status: "disconnected", document: null, files: [] },
    { action: "disconnect", teamId: "team" },
  );
  expect(disconnected.document).toBeNull();
});
