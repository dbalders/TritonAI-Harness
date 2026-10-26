import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const Identity = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

export const ExternalContentScope = Schema.Struct({
  id: Identity,
  version: PositiveInt,
  exposureVersion: NonNegativeInt,
  providerSessionId: Identity,
});
export type ExternalContentScope = typeof ExternalContentScope.Type;

export const ExternalToolSource = Schema.Struct({
  integrationId: Identity,
  integrationVersion: Identity,
  toolName: Identity,
  connectionGeneration: Identity,
});
export type ExternalToolSource = typeof ExternalToolSource.Type;

export const ExternalDerivedSource = Schema.Struct({
  kind: Schema.Literal("derived"),
  artifactKind: Schema.Literals(["idea", "memory", "project-overview", "legacy-history"]),
  artifactId: Identity,
  contentDigest: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
});
export type ExternalDerivedSource = typeof ExternalDerivedSource.Type;

export const ExternalContentSource = Schema.Union([ExternalToolSource, ExternalDerivedSource]);

export const ExternalContentReview = Schema.Struct({
  scope: ExternalContentScope,
  /** Host identifiers only. Source text never becomes an approval instruction. */
  sources: Schema.Array(ExternalContentSource).check(Schema.isMaxLength(8)),
});
export type ExternalContentReview = typeof ExternalContentReview.Type;

export const ExternalToolResult = Schema.Struct({
  protocol: Schema.Literal("tritonai.external-tool-result/v1"),
  trust: Schema.Literal("untrusted"),
  authority: Schema.Literal("data-only"),
  invocationId: Identity,
  source: ExternalToolSource,
  scope: ExternalContentScope,
  isError: Schema.Boolean,
  data: Schema.Record(Schema.String, Schema.Unknown),
});
export type ExternalToolResult = typeof ExternalToolResult.Type;
