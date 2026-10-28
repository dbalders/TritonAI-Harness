import {
  isFeatureAvailable as isAvailable,
  resolveFeatureEnvironment,
  type FeatureId,
} from "@t3tools/shared/features";

import { APP_VERSION, HOSTED_APP_CHANNEL } from "./branding";
import { isElectron } from "./env";

const hostedChannel = isElectron ? null : HOSTED_APP_CHANNEL;
const environment = resolveFeatureEnvironment({
  version: APP_VERSION,
  development: import.meta.env.DEV,
  channel: hostedChannel === "latest" ? "stable" : hostedChannel,
});

export function isFeatureAvailable(feature: FeatureId): boolean {
  return isAvailable(feature, environment);
}
