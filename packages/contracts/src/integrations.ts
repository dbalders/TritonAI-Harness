import * as Schema from "effect/Schema";

import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const IntegrationCapabilityId = TrimmedNonEmptyString;
export type IntegrationCapabilityId = typeof IntegrationCapabilityId.Type;

export const IntegrationConnectionState = Schema.Literals([
  "not_connected",
  "connecting",
  "connected",
  "error",
]);
export type IntegrationConnectionState = typeof IntegrationConnectionState.Type;

export const IntegrationCapability = Schema.Struct({
  id: IntegrationCapabilityId,
  displayName: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  granted: Schema.Boolean,
});

export const IntegrationTool = Schema.Struct({
  name: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  capability: IntegrationCapabilityId,
  available: Schema.Boolean,
});

export const IntegrationSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  capability: IntegrationCapabilityId,
  available: Schema.Boolean,
});

export const IntegrationSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  apiVersion: Schema.Literal("tritonai.harness/v1"),
  installed: Schema.Boolean,
  enabled: Schema.Boolean,
  compatible: Schema.Boolean,
  compatibilityMessage: Schema.NullOr(TrimmedNonEmptyString),
  connectionState: IntegrationConnectionState,
  accountLabel: Schema.NullOr(TrimmedNonEmptyString),
  statusMessage: Schema.NullOr(TrimmedNonEmptyString),
  capabilities: Schema.Array(IntegrationCapability),
  tools: Schema.Array(IntegrationTool),
  skills: Schema.Array(IntegrationSkill),
});
export type IntegrationSummary = typeof IntegrationSummary.Type;

export const IntegrationsListResult = Schema.Struct({
  integrations: Schema.Array(IntegrationSummary),
});
export type IntegrationsListResult = typeof IntegrationsListResult.Type;

export const IntegrationIdInput = Schema.Struct({ id: TrimmedNonEmptyString });
export const IntegrationSetEnabledInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export const IntegrationConnectInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  capabilities: Schema.Array(IntegrationCapabilityId),
});
export const IntegrationPollInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  flowId: TrimmedNonEmptyString,
});

export const IntegrationConnectResult = Schema.Struct({
  flowId: TrimmedNonEmptyString,
  verificationUri: TrimmedNonEmptyString,
  verificationUriComplete: Schema.NullOr(TrimmedNonEmptyString),
  userCode: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  intervalSeconds: PositiveInt,
});
export type IntegrationConnectResult = typeof IntegrationConnectResult.Type;

export const IntegrationPollResult = Schema.Struct({
  state: Schema.Literals(["pending", "connected", "expired", "failed"]),
  retryAfterSeconds: Schema.NullOr(PositiveInt),
  message: Schema.NullOr(TrimmedNonEmptyString),
  integration: IntegrationSummary,
});
export type IntegrationPollResult = typeof IntegrationPollResult.Type;

export class IntegrationOperationError extends Schema.TaggedErrorClass<IntegrationOperationError>()(
  "IntegrationOperationError",
  {
    code: Schema.Literals([
      "not_found",
      "invalid_manifest",
      "incompatible",
      "not_installed",
      "disabled",
      "not_connected",
      "capability_required",
      "operation_failed",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}
