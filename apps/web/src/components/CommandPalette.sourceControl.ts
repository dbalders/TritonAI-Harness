import type { SourceControlDiscoveryResult, SourceControlProviderKind } from "@t3tools/contracts";
import * as Option from "effect/Option";

export type AddProjectRemoteProviderKind = Extract<
  SourceControlProviderKind,
  "github" | "gitlab" | "bitbucket" | "azure-devops"
>;
export type AddProjectRemoteSource = AddProjectRemoteProviderKind | "url";

const REMOTE_PROJECT_SOURCES: ReadonlyArray<AddProjectRemoteSource> = [
  "url",
  "github",
  "gitlab",
  "bitbucket",
  "azure-devops",
];
const REMOTE_PROJECT_PROVIDER_SOURCES: ReadonlyArray<AddProjectRemoteProviderKind> = [
  "github",
  "gitlab",
  "bitbucket",
  "azure-devops",
];

export function remoteProjectSourceLabel(source: AddProjectRemoteSource): string {
  switch (source) {
    case "github":
      return "GitHub";
    case "gitlab":
      return "GitLab";
    case "bitbucket":
      return "Bitbucket";
    case "azure-devops":
      return "Azure DevOps";
    case "url":
      return "Git URL";
  }
}

export function remoteProjectSourcePathHint(source: AddProjectRemoteSource): string {
  switch (source) {
    case "github":
      return "owner/repo";
    case "gitlab":
      return "group/project";
    case "bitbucket":
      return "workspace/repository";
    case "azure-devops":
      return "project/repository";
    case "url":
      return "URL";
  }
}

export type AddProjectRemoteSourceReadiness = Record<
  AddProjectRemoteSource,
  {
    readonly visible: boolean;
    readonly ready: boolean;
    readonly hint: string | null;
  }
>;

export function sortAddProjectProviderSources(
  readinessBySource: AddProjectRemoteSourceReadiness,
): ReadonlyArray<AddProjectRemoteProviderKind> {
  return REMOTE_PROJECT_PROVIDER_SOURCES.filter(
    (source) => readinessBySource[source].visible,
  ).toSorted((left, right) => {
    const leftReady = readinessBySource[left].ready;
    const rightReady = readinessBySource[right].ready;
    if (leftReady !== rightReady) {
      return leftReady ? -1 : 1;
    }
    return remoteProjectSourceLabel(left).localeCompare(remoteProjectSourceLabel(right));
  });
}

export function buildAddProjectRemoteSourceReadiness(
  discovery: SourceControlDiscoveryResult | null,
): AddProjectRemoteSourceReadiness {
  const unavailable = {
    visible: false,
    ready: false,
    hint: "Provider status unavailable. Open Settings -> Source Control and rescan.",
  } as const;
  const defaultReadiness: AddProjectRemoteSourceReadiness = {
    url: { visible: true, ready: true, hint: null },
    github: unavailable,
    gitlab: unavailable,
    bitbucket: unavailable,
    "azure-devops": unavailable,
  };

  if (!discovery) {
    return defaultReadiness;
  }

  const providerByKind = new Map(
    discovery.sourceControlProviders.map((provider) => [provider.kind, provider]),
  );
  const readiness = { ...defaultReadiness };

  for (const source of REMOTE_PROJECT_SOURCES) {
    if (source === "url") continue;
    const provider = providerByKind.get(source);
    if (!provider || provider.status !== "available") {
      continue;
    }
    if (source === "bitbucket" && provider.auth.status === "unauthenticated") {
      continue;
    }
    if (provider.auth.status === "unauthenticated") {
      readiness[source] = {
        visible: true,
        ready: false,
        hint:
          Option.getOrNull(provider.auth.detail) ??
          `${provider.label} is not authenticated. Open Settings -> Source Control for setup guidance.`,
      };
      continue;
    }
    readiness[source] = { visible: true, ready: true, hint: null };
  }

  return readiness;
}
