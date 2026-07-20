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
  access: Schema.Literals(["default", "opt-in"]),
  enabled: Schema.Boolean,
  granted: Schema.Boolean,
  available: Schema.Boolean,
});

export const IntegrationTool = Schema.Struct({
  name: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  capabilities: Schema.Array(IntegrationCapabilityId),
  effect: Schema.Literals(["read", "write"]),
  available: Schema.Boolean,
});

export const IntegrationSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  capabilities: Schema.Array(IntegrationCapabilityId),
  /** Derived from enabled capability bundles; never an independent user switch. */
  enabled: Schema.Boolean,
  available: Schema.Boolean,
});

export const IntegrationSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  apiVersion: Schema.Literal("tritonai.harness/v2"),
  installed: Schema.Boolean,
  enabled: Schema.Boolean,
  requiresConnection: Schema.Boolean,
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
export const IntegrationSetCapabilityEnabledInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  capability: IntegrationCapabilityId,
  enabled: Schema.Boolean,
});
export const IntegrationApiKeySubmission = Schema.Struct({
  kind: Schema.Literal("api_key"),
  flowId: TrimmedNonEmptyString,
  value: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(16_384)),
});
export type IntegrationApiKeySubmission = typeof IntegrationApiKeySubmission.Type;

export const IntegrationConnectionSubmission = IntegrationApiKeySubmission;
export type IntegrationConnectionSubmission = typeof IntegrationConnectionSubmission.Type;

export const IntegrationConnectInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  submission: Schema.optional(IntegrationConnectionSubmission),
});
export const IntegrationPollInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  flowId: TrimmedNonEmptyString,
});

export const IntegrationDeviceCodeConnectResult = Schema.Struct({
  kind: Schema.Literal("device_code"),
  flowId: TrimmedNonEmptyString,
  verificationUri: TrimmedNonEmptyString,
  verificationUriComplete: Schema.NullOr(TrimmedNonEmptyString),
  userCode: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  intervalSeconds: PositiveInt,
});
export type IntegrationDeviceCodeConnectResult = typeof IntegrationDeviceCodeConnectResult.Type;

export const IntegrationApiKeyConnectResult = Schema.Struct({
  kind: Schema.Literal("api_key"),
  flowId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  placeholder: Schema.NullOr(TrimmedNonEmptyString),
  message: TrimmedNonEmptyString,
});
export type IntegrationApiKeyConnectResult = typeof IntegrationApiKeyConnectResult.Type;

export const IntegrationConnectedConnectResult = Schema.Struct({
  kind: Schema.Literal("connected"),
  flowId: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type IntegrationConnectedConnectResult = typeof IntegrationConnectedConnectResult.Type;

// Keep connection UX discriminated from the first version so redirect, API-key,
// and other authorization flows can extend this contract without optional-field
// ambiguity in clients.
export const IntegrationConnectResult = Schema.Union([
  IntegrationDeviceCodeConnectResult,
  IntegrationApiKeyConnectResult,
  IntegrationConnectedConnectResult,
]);
export type IntegrationConnectResult = typeof IntegrationConnectResult.Type;

export const IntegrationProviderPollResult = Schema.Struct({
  state: Schema.Literals(["pending", "connected", "expired", "failed"]),
  retryAfterSeconds: Schema.NullOr(PositiveInt),
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type IntegrationProviderPollResult = typeof IntegrationProviderPollResult.Type;

export const IntegrationPollResult = Schema.Struct({
  ...IntegrationProviderPollResult.fields,
  integration: IntegrationSummary,
});
export type IntegrationPollResult = typeof IntegrationPollResult.Type;

export class IntegrationOperationError extends Schema.TaggedErrorClass<IntegrationOperationError>()(
  "IntegrationOperationError",
  {
    code: Schema.Literals([
      "not_found",
      "invalid_manifest",
      "not_installed",
      "disabled",
      "not_connected",
      "capability_required",
      "invalid_input",
      "operation_failed",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}
