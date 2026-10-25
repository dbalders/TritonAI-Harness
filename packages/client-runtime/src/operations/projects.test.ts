import { type EnvironmentProject } from "../state/models.ts";
import * as Option from "effect/Option";
import { SourceControlProviderKind, SourceControlDiscoveryResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  findExistingAddProject,
  getCloneDirectoryName,
  getDefaultCloneUrl,
  normalizePastedCloneUrl,
  getReadyAddProjectProviderSources,
  buildAddProjectRemoteSourceReadiness,
} from "./projects.ts";

describe("add project shared logic", () => {
  it("routes owner/repository shorthand to GitHub over HTTPS", () => {
    expect(normalizePastedCloneUrl("imputnet/helium")).toBe(
      "https://github.com/imputnet/helium.git",
    );
    expect(normalizePastedCloneUrl("  pingdotgg/t3code  ")).toBe(
      "https://github.com/pingdotgg/t3code.git",
    );
  });

  it("keeps explicit clone URLs and local paths unchanged", () => {
    expect(normalizePastedCloneUrl("https://gitlab.com/group/project.git")).toBe(
      "https://gitlab.com/group/project.git",
    );
    expect(normalizePastedCloneUrl("git@github.com:owner/repo.git")).toBe(
      "git@github.com:owner/repo.git",
    );
    expect(normalizePastedCloneUrl("group/subgroup/project")).toBe("group/subgroup/project");
    expect(normalizePastedCloneUrl("/srv/git/repo.git")).toBe("/srv/git/repo.git");
  });

  it("uses HTTPS for repositories selected through a provider", () => {
    expect(
      getDefaultCloneUrl({
        provider: SourceControlProviderKind.make("github"),
        url: "https://github.com/imputnet/helium",
        sshUrl: "git@github.com:imputnet/helium.git",
      }),
    ).toBe("https://github.com/imputnet/helium");
    expect(
      getDefaultCloneUrl({
        provider: SourceControlProviderKind.make("forgejo"),
        url: "https://forgejo.example.test:8443/owner/repo.git",
        sshUrl: "ssh://git@forgejo.example.test:2222/owner/repo.git",
      }),
    ).toBe("https://forgejo.example.test:8443/owner/repo.git");
  });

  it("derives the clone folder name from any pasted clone URL", () => {
    expect(getCloneDirectoryName("https://github.com/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo/")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("ssh://git@github.com:22/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://user@bitbucket.org/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://dev.azure.com/org/project/_git/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo.git?ref=main#readme")).toBe("repo");
    expect(getCloneDirectoryName("/srv/git/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("C:\\src\\repo.git")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:repo.git")).toBe("repo");
    expect(getCloneDirectoryName("  https://github.com/owner/repo.git  ")).toBe("repo");
  });

  it("keeps a numeric repository name that sits on a path", () => {
    expect(getCloneDirectoryName("https://github.com/acme/123.git")).toBe("123");
    expect(getCloneDirectoryName("https://github.com/acme/123")).toBe("123");
    expect(getCloneDirectoryName("git@github.com:acme/123.git")).toBe("123");
  });

  it("marks authenticated source control providers as ready", () => {
    const discovery: SourceControlDiscoveryResult = {
      versionControlSystems: [],
      sourceControlProviders: [
        {
          kind: SourceControlProviderKind.make("github"),
          label: "GitHub",
          status: "available",
          installHint: "Install gh",
          version: Option.some("1.0.0"),
          detail: Option.none(),
          auth: {
            status: "authenticated",
            account: Option.some("octo"),
            host: Option.some("github.com"),
            detail: Option.none(),
          },
        },
        {
          kind: SourceControlProviderKind.make("gitlab"),
          label: "GitLab",
          status: "available",
          installHint: "Install glab",
          version: Option.some("1.0.0"),
          detail: Option.none(),
          auth: {
            status: "unauthenticated",
            account: Option.none(),
            host: Option.none(),
            detail: Option.some("Run glab auth login"),
          },
        },
      ],
    };

    const readiness = buildAddProjectRemoteSourceReadiness(discovery);
    expect(readiness("url").ready).toBe(true);
    expect(readiness(SourceControlProviderKind.make("github")).ready).toBe(true);
    expect(readiness(SourceControlProviderKind.make("gitlab"))).toEqual({
      ready: false,
      hint: "Run glab auth login",
    });
    expect(getReadyAddProjectProviderSources(readiness)).toEqual(["github"]);
  });

  // regression: 3038299db4 fix(source-control): hide providers until setup is complete
  it.each([null, { versionControlSystems: [], sourceControlProviders: [] }])(
    "offers no provider shortcuts before setup or discovery completes: %s",
    (discovery) => {
      const readiness = buildAddProjectRemoteSourceReadiness(discovery);
      expect(getReadyAddProjectProviderSources(readiness)).toEqual([]);
      expect(readiness("url").ready).toBe(true);
    },
  );

  // regression: 3038299db4 fix(source-control): hide providers until setup is complete
  it("only offers installed, authenticated hosts and updates after setup changes", () => {
    const provider = (
      kind: string,
      status: "available" | "missing",
      authStatus: "authenticated" | "unauthenticated" | "unknown",
    ) => ({
      kind: SourceControlProviderKind.make(kind),
      label: kind,
      status,
      installHint: "Install provider CLI",
      version: Option.none(),
      detail: Option.none(),
      auth: {
        status: authStatus,
        account: Option.none(),
        host: Option.none(),
        detail: Option.none(),
      },
    });
    const discovery = {
      versionControlSystems: [],
      sourceControlProviders: [
        provider("github", "available", "authenticated"),
        provider("gitlab", "available", "authenticated"),
        provider("azure-devops", "missing", "authenticated"),
        provider("bitbucket", "available", "unauthenticated"),
        provider("forgejo", "available", "unknown"),
      ],
    };
    expect(
      getReadyAddProjectProviderSources(buildAddProjectRemoteSourceReadiness(discovery)),
    ).toEqual(["github", "gitlab"]);
    discovery.sourceControlProviders[1] = provider("gitlab", "available", "unauthenticated");
    discovery.sourceControlProviders[3] = provider("bitbucket", "available", "authenticated");
    expect(
      getReadyAddProjectProviderSources(buildAddProjectRemoteSourceReadiness(discovery)),
    ).toEqual(["bitbucket", "github"]);
  });

  it("finds existing projects by normalized path in the target environment", () => {
    const env = EnvironmentId.make("env");
    const other = EnvironmentId.make("other");
    const projects: EnvironmentProject[] = [
      {
        environmentId: other,
        id: ProjectId.make("same-path-other-env"),
        title: "Other",
        workspaceRoot: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
      {
        environmentId: env,
        id: ProjectId.make("project"),
        title: "Repo",
        workspaceRoot: "/repo/",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
    ];

    expect(findExistingAddProject({ projects, environmentId: env, path: "/repo" })?.id).toBe(
      "project",
    );
  });
});
