import { cliReleaseChannelOf, type CliReleaseChannel } from "./cliRelease.ts";

export type FeatureEnvironment = "development" | CliReleaseChannel;

// Availability belongs here; opt-in and defaults stay in the feature's existing settings.
const FEATURE_ENVIRONMENTS = {
  guidedTour: ["development", "nightly", "preview"],
} satisfies Record<string, ReadonlyArray<FeatureEnvironment>>;

export type FeatureId = keyof typeof FEATURE_ENVIRONMENTS;

export function isFeatureAvailable(feature: FeatureId, environment: FeatureEnvironment): boolean {
  const environments: ReadonlyArray<FeatureEnvironment> = FEATURE_ENVIRONMENTS[feature];
  return environments.includes(environment);
}

export function resolveFeatureEnvironment(input: {
  readonly version: string;
  readonly development?: boolean;
  readonly channel?: CliReleaseChannel | null;
}): FeatureEnvironment {
  if (input.development) return "development";
  return input.channel ?? cliReleaseChannelOf(input.version);
}
