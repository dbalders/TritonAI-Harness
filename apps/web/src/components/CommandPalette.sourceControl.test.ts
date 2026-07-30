import type { SourceControlDiscoveryResult } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  buildAddProjectRemoteSourceReadiness,
  sortAddProjectProviderSources,
} from "./CommandPalette.sourceControl";

function discovery(): SourceControlDiscoveryResult {
  const shared = {
    executable: "provider-cli",
    version: Option.some("1.0.0"),
    installHint: "Install the provider CLI.",
    detail: Option.none<string>(),
  };

  return {
    versionControlSystems: [],
    sourceControlProviders: [
      {
        ...shared,
        kind: "github",
        label: "GitHub",
        status: "available",
        auth: {
          status: "authenticated",
          account: Option.some("octocat"),
          host: Option.some("github.com"),
          detail: Option.none(),
        },
      },
      {
        ...shared,
        kind: "bitbucket",
        label: "Bitbucket",
        status: "available",
        auth: {
          status: "unauthenticated",
          account: Option.none(),
          host: Option.some("bitbucket.org"),
          detail: Option.some("Configure Bitbucket credentials."),
        },
      },
      {
        ...shared,
        kind: "gitlab",
        label: "GitLab",
        status: "missing",
        auth: {
          status: "unknown",
          account: Option.none(),
          host: Option.none(),
          detail: Option.none(),
        },
      },
      {
        ...shared,
        kind: "azure-devops",
        label: "Azure DevOps",
        status: "missing",
        auth: {
          status: "unknown",
          account: Option.none(),
          host: Option.none(),
          detail: Option.none(),
        },
      },
    ],
  };
}

describe("add-project source control providers", () => {
  it("shows available providers and hides providers that are turned off", () => {
    const readiness = buildAddProjectRemoteSourceReadiness(discovery());

    expect(sortAddProjectProviderSources(readiness)).toEqual(["github", "bitbucket"]);
    expect(readiness.gitlab.visible).toBe(false);
    expect(readiness["azure-devops"].visible).toBe(false);
  });

  it("keeps enabled but unauthenticated providers visible as setup required", () => {
    const readiness = buildAddProjectRemoteSourceReadiness(discovery());

    expect(readiness.bitbucket).toEqual({
      visible: true,
      ready: false,
      hint: "Configure Bitbucket credentials.",
    });
  });

  it("does not show provider rows before discovery is available", () => {
    const readiness = buildAddProjectRemoteSourceReadiness(null);

    expect(sortAddProjectProviderSources(readiness)).toEqual([]);
  });
});
