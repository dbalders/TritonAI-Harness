import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSidebarProjectPickerEntries } from "./sidebarProjectGrouping";
import {
  buildRegularSidebarProjectSnapshots,
  isRegularProjectThreadContext,
  resolveGenericNewThreadShortcutAction,
  sortRegularScopedProjectsForSidebar,
} from "./tritonAiProjectSurfaces";
import type { Project } from "./types";

const primaryEnvironmentId = EnvironmentId.make("env-primary");
const groupingSettings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.make("project-1"),
    environmentId: primaryEnvironmentId,
    title: "Project",
    workspaceRoot: "/tmp/project",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

describe("generic TritonAI project surfaces", () => {
  it("counts a regular project plus Chats as one generic new-thread choice", () => {
    const regularProject = makeProject();
    const chatsProject = makeProject({
      id: ProjectId.make("chats"),
      title: "Chats",
      workspaceRoot: "~/.tritonai-harness/chats",
    });

    const groups = buildRegularSidebarProjectSnapshots({
      projects: [regularProject, chatsProject],
      settings: groupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe(regularProject.id);
    expect(
      isRegularProjectThreadContext([regularProject, chatsProject], {
        environmentId: regularProject.environmentId,
        projectId: regularProject.id,
      }),
    ).toBe(true);
    expect(
      resolveGenericNewThreadShortcutAction({
        command: "chat.new",
        projectGroupCount: groups.length,
        sidebarV2Enabled: true,
      }),
    ).toBe("start");
  });

  it("keeps Chats absent from the draft project picker", () => {
    const regularProject = makeProject();
    const chatsProject = makeProject({
      id: ProjectId.make("chats"),
      title: "Chats",
      workspaceRoot: "~/.tritonai-harness/chats",
    });
    const groups = buildRegularSidebarProjectSnapshots({
      projects: [regularProject, chatsProject],
      settings: groupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });
    const pickerEntries = buildSidebarProjectPickerEntries({
      groups,
      preferredProjectRef: {
        environmentId: chatsProject.environmentId,
        projectId: chatsProject.id,
      },
    });

    expect(pickerEntries.map((entry) => entry.targetProject.id)).toEqual([regularProject.id]);
  });

  it("never chooses Chats as the generic index-route default", () => {
    const regularProject = makeProject({
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const chatsProject = makeProject({
      id: ProjectId.make("chats"),
      title: "Chats",
      workspaceRoot: "/Users/david/.tritonai-harness/chats",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    expect(
      sortRegularScopedProjectsForSidebar([regularProject, chatsProject], [], "updated_at").map(
        (project) => project.id,
      ),
    ).toEqual([regularProject.id]);
  });

  it("does not start a generic thread when Chats is the only project", () => {
    const chatsProject = makeProject({
      id: ProjectId.make("chats"),
      title: "Chats",
      workspaceRoot: "~/.tritonai-harness/chats",
    });
    const groups = buildRegularSidebarProjectSnapshots({
      projects: [chatsProject],
      settings: groupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });
    const chatsContext = {
      environmentId: chatsProject.environmentId,
      projectId: chatsProject.id,
    };

    expect(groups).toEqual([]);
    expect(sortRegularScopedProjectsForSidebar([chatsProject], [], "updated_at")).toEqual([]);
    expect(isRegularProjectThreadContext([chatsProject], chatsContext)).toBe(false);
    expect(
      resolveGenericNewThreadShortcutAction({
        command: "chat.new",
        projectGroupCount: groups.length,
        sidebarV2Enabled: true,
      }),
    ).toBe("none");
    expect(
      resolveGenericNewThreadShortcutAction({
        command: "chat.newLocal",
        projectGroupCount: groups.length,
        sidebarV2Enabled: false,
      }),
    ).toBe("none");
  });
});
