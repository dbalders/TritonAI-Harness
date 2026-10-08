import { describe, expect, it, vi } from "vite-plus/test";
import type { TeamsResult, TeamStorageStatus } from "@t3tools/contracts";
import { createTeamsController, mergeTeamStorageResult } from "./teams.ts";
const empty: TeamsResult = { teams: [], invitations: [], team: null, invitationCode: null };
describe("team account lifecycle", () => {
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
  const disconnected = mergeTeamStorageResult(
    opened,
    { ...opened, status: "disconnected", document: null, files: [] },
    { action: "disconnect", teamId: "team" },
  );
  expect(disconnected.document).toBeNull();
});
