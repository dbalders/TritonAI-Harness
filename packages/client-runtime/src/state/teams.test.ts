import { describe, expect, it, vi } from "vite-plus/test";
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
  role: "editor",
  canManage: false,
  state: "ready",
  revision: 1,
  members: [],
  invitations: [],
  storage: null,
};
describe("team account lifecycle", () => {
  it("retains the selected team through a temporary refresh failure and clears it on revocation", async () => {
    const pending = Promise.withResolvers<TeamsResult>();
    const opened: TeamsResult = {
      ...empty,
      team: {
        id: "team",
        reference: "T-TEST",
        name: "Synthetic",
        role: "editor",
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
    expect(controller.getSnapshot()).toEqual({ result: null, busy: false, error: null });
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
    const execute = vi
      .fn()
      .mockResolvedValueOnce(invited("a"))
      .mockResolvedValueOnce(invited("a"))
      .mockResolvedValueOnce(opened);
    const controller = createTeamsController(execute);
    const stopSidebar = controller.activate();
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
