import { describe, expect, it } from "vite-plus/test";

import {
  TRITONAI_CHATS_WORKSPACE,
  TRITONAI_FIRST_RUN_WORKSPACE,
  findPrimaryTritonAiChatsProject,
  findPrimaryTritonAiChatsProjects,
  isTritonAiChatsWorkspacePath,
  isTritonAiCodeBrand,
  isTritonAiWorkspacePath,
  partitionTritonAiChatsProjects,
  resolveTritonAiChatsWorkspacePath,
  resolveTritonAiFirstRunWorkspacePath,
} from "./tritonAiWorkspace";

describe("tritonAiWorkspace", () => {
  it("is scoped to the TritonAI Harness brand", () => {
    expect(isTritonAiCodeBrand("TritonAI Harness")).toBe(true);
    expect(isTritonAiCodeBrand("TritonAI Code")).toBe(false);
  });

  it("resolves the first-run TritonAI home workspace", () => {
    expect(resolveTritonAiFirstRunWorkspacePath()).toBe(TRITONAI_FIRST_RUN_WORKSPACE);
    expect(isTritonAiWorkspacePath("~/TritonAI")).toBe(true);
    expect(isTritonAiWorkspacePath("/Users/david/TritonAI/")).toBe(true);
    expect(isTritonAiWorkspacePath("/home/david/TritonAI")).toBe(true);
    expect(isTritonAiWorkspacePath("C:\\Users\\david\\TritonAI")).toBe(true);
    expect(isTritonAiWorkspacePath("~/Projects/TritonAI")).toBe(false);
  });

  it("resolves the canonical TritonAI Harness chats workspace", () => {
    expect(resolveTritonAiChatsWorkspacePath()).toBe(TRITONAI_CHATS_WORKSPACE);
    expect(isTritonAiChatsWorkspacePath("~/.tritonai-harness/chats")).toBe(true);
    expect(isTritonAiChatsWorkspacePath("/Users/david/.tritonai-harness/chats/")).toBe(true);
    expect(isTritonAiChatsWorkspacePath("/work/repo/.tritonai-harness/chats")).toBe(false);
  });

  it("recognizes legacy TritonAI Code chats workspaces", () => {
    expect(isTritonAiChatsWorkspacePath("~/.agents/ucsd/state/tritonai-code/chats")).toBe(true);
    expect(isTritonAiChatsWorkspacePath("/home/david/.agents/ucsd/state/tritonai-code/chats")).toBe(
      true,
    );
  });

  it("rejects normal project paths", () => {
    expect(isTritonAiChatsWorkspacePath("~/Projects/t3code")).toBe(false);
    expect(isTritonAiChatsWorkspacePath("/Users/david/.tritonai-harness/chat-history")).toBe(false);
    expect(isTritonAiChatsWorkspacePath("/work/repo/.agents/ucsd/state/tritonai-code/chats")).toBe(
      false,
    );
  });

  it("keeps every hidden chats workspace out of the regular Projects collection", () => {
    const canonicalChats = { id: "canonical", workspaceRoot: "~/.tritonai-harness/chats" };
    const legacyChats = {
      id: "legacy",
      workspaceRoot: "/Users/david/.agents/ucsd/state/tritonai-code/chats",
    };
    const normalProject = { id: "project", workspaceRoot: "/Users/david/TritonAI" };

    expect(partitionTritonAiChatsProjects([canonicalChats, normalProject, legacyChats])).toEqual({
      chatsProjects: [canonicalChats, legacyChats],
      regularProjects: [normalProject],
    });
  });

  it("selects Chats only from the primary environment", () => {
    const remoteChats = {
      id: "remote",
      environmentId: "remote-env",
      workspaceRoot: "/home/david/.tritonai-harness/chats",
    };
    const localChats = {
      id: "local",
      environmentId: "local-env",
      workspaceRoot: "/Users/david/.tritonai-harness/chats",
    };
    const legacyLocalChats = {
      id: "legacy-local",
      environmentId: "local-env",
      workspaceRoot: "/Users/david/.agents/ucsd/state/tritonai-code/chats",
    };

    expect(
      findPrimaryTritonAiChatsProjects([remoteChats, legacyLocalChats, localChats], "local-env"),
    ).toEqual([localChats, legacyLocalChats]);
    expect(findPrimaryTritonAiChatsProject([legacyLocalChats, localChats], "local-env")).toBe(
      localChats,
    );
    expect(findPrimaryTritonAiChatsProject([legacyLocalChats], "local-env")).toBe(legacyLocalChats);
    expect(findPrimaryTritonAiChatsProject([remoteChats], "local-env")).toBeNull();
    expect(findPrimaryTritonAiChatsProject([localChats], null)).toBeNull();
  });
});
