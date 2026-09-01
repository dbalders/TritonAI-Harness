import * as Schema from "effect/Schema";

import { ModelCapabilities } from "./model.ts";

const ManagedHttpsUrl = Schema.String.check(
  Schema.isMaxLength(2_048),
  Schema.isPattern(/^https:\/\/[^\s]+$/u),
);

const ManagedModel = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  shortName: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
  route: Schema.Literals(["on-prem", "frontier"]),
  capabilities: Schema.optionalKey(ModelCapabilities),
});

/**
 * Non-secret policy carried by every signed TritonAI Harness release.
 * Excess properties are rejected by the build and runtime decoders.
 */
export const TritonAiManagedConfig = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  policyVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  provider: Schema.Struct({
    driver: Schema.Literal("codex"),
    managedBinary: Schema.Literal(true),
    managedHome: Schema.Literal(true),
    baseUrl: ManagedHttpsUrl,
    sharedApiKeyEnvironmentVariable: Schema.Literal("TRITONAI_API_KEY"),
    apiKeySourceEnvironmentVariable: Schema.Literal("TRITONAI_API_KEY_SOURCE"),
    routes: Schema.Struct({
      onPrem: Schema.Struct({
        id: Schema.Literal("on-prem"),
        instanceId: Schema.Literal("codex"),
        displayName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
        apiKeyEnvironmentVariable: Schema.Literal("TRITONAI_ONPREM_API_KEY"),
      }),
      frontier: Schema.Struct({
        id: Schema.Literal("frontier"),
        instanceId: Schema.Literal("codex_frontier"),
        displayName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
        apiKeyEnvironmentVariable: Schema.Literal("TRITONAI_FRONTIER_API_KEY"),
      }),
    }),
  }),
  models: Schema.Struct({
    default: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    restrictedFallback: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    replacements: Schema.Record(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    ),
    catalog: Schema.Array(ManagedModel).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  }),
  secureSkills: Schema.Struct({
    endpoint: Schema.optionalKey(ManagedHttpsUrl),
    pollIntervalMinutes: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(5),
      Schema.isLessThanOrEqualTo(1_440),
    ),
  }),
});
export type TritonAiManagedConfig = typeof TritonAiManagedConfig.Type;

export const ManagedPolicyMigrationStatus = Schema.Literals(["not-needed", "completed"]);
export type ManagedPolicyMigrationStatus = typeof ManagedPolicyMigrationStatus.Type;

export const SecureSkillsSyncStatus = Schema.Literals([
  "not-configured",
  "missing-credential",
  "idle",
  "syncing",
  "current",
  "error",
]);
export type SecureSkillsSyncStatus = typeof SecureSkillsSyncStatus.Type;

export const TritonAiManagedPolicyDiagnostics = Schema.Struct({
  applicationVersion: Schema.String,
  schemaVersion: Schema.Literal(2),
  policyVersion: Schema.Int,
  configDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  loaded: Schema.Boolean,
  managedProviderInstanceId: Schema.String,
  managedProviderInstanceIds: Schema.optionalKey(Schema.Array(Schema.String)),
  migrationStatus: ManagedPolicyMigrationStatus,
  managedCategories: Schema.Array(Schema.String),
  secureSkillsStatus: SecureSkillsSyncStatus,
  secureSkillsRevision: Schema.NullOr(Schema.String),
  secureSkillsLastCheckedAt: Schema.NullOr(Schema.String),
  secureSkillsMessage: Schema.NullOr(Schema.String),
});
export type TritonAiManagedPolicyDiagnostics = typeof TritonAiManagedPolicyDiagnostics.Type;
