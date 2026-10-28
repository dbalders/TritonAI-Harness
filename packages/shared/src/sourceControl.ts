import { type SourceControlProviderDiscoveryItem } from "@t3tools/contracts";

export interface ChangeRequestPresentation {
  readonly icon:
    | "github"
    | "gitlab"
    | "forgejo"
    | "azure-devops"
    | "bitbucket"
    | "gitcafe"
    | "change-request";
  readonly providerName: string;
  readonly shortName: string;
  readonly longName: string;
  readonly pluralLongName: string;
  readonly providerLongName: string;
  readonly checkoutCommandExample?: string;
  readonly urlExample: string;
}

export interface ChangeRequestTerminology {
  readonly shortLabel: string;
  readonly singular: string;
}

export function isSourceControlProviderReady(
  provider: SourceControlProviderDiscoveryItem,
): boolean {
  return provider.status === "available" && provider.auth.status === "authenticated";
}

const SCP_SSH_REMOTE_PATTERN = /^[a-zA-Z0-9._-]+@([^:/]+):/;

export function isSshRemoteUrl(remoteUrl: string): boolean {
  const trimmed = remoteUrl.trim();
  return SCP_SSH_REMOTE_PATTERN.test(trimmed) || trimmed.toLowerCase().startsWith("ssh://");
}
