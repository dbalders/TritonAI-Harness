import * as Schema from "effect/Schema";
import { EnvironmentId, NonNegativeInt } from "./baseSchemas.ts";
import { DesktopComputerUseStateSchema, type DesktopComputerUseState } from "./ipc.ts";

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
);

export const HelpMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  content: text(8_000).check(Schema.isMinLength(1)),
});
export type HelpMessage = typeof HelpMessage.Type;

/** A support-safe current value, never a credential or raw configuration object. */
export const HelpSetting = Schema.Struct({
  key: text(300),
  value: text(4_000),
  configured: Schema.optionalKey(Schema.Boolean),
});
export type HelpSetting = typeof HelpSetting.Type;

export const HelpSettingsSnapshot = Schema.Struct({
  entries: Schema.Array(HelpSetting).check(Schema.isMaxLength(300)),
  totalCount: NonNegativeInt,
  omittedCount: NonNegativeInt,
});
export type HelpSettingsSnapshot = typeof HelpSettingsSnapshot.Type;

/** Client observations are reported by the requesting client, not by the environment host. */
const HelpClientContextSchema = Schema.Struct({
  surface: Schema.Literals(["desktop", "web"]),
  platform: text(200),
  settingsStatus: Schema.Literals(["ready", "unavailable"]),
  settings: HelpSettingsSnapshot,
  settingsCatalog: Schema.Array(
    Schema.Struct({
      id: text(200),
      title: text(200),
      route: text(300),
      searchTerms: text(1_000),
      scope: Schema.optionalKey(text(100)),
    }),
  ).check(Schema.isMaxLength(400)),
  computerUse: Schema.optionalKey(DesktopComputerUseStateSchema),
}).check(
  Schema.makeFilter(
    (value) =>
      JSON.stringify(value).length <= 120_000 || "Client support context exceeds its budget.",
  ),
);
export interface HelpClientContext {
  readonly surface: "desktop" | "web";
  readonly platform: string;
  readonly settingsStatus: "ready" | "unavailable";
  readonly settings: HelpSettingsSnapshot;
  readonly settingsCatalog: readonly {
    readonly id: string;
    readonly title: string;
    readonly route: string;
    readonly searchTerms: string;
    readonly scope?: string;
  }[];
  readonly computerUse?: DesktopComputerUseState;
}
export const HelpClientContext: Schema.Codec<HelpClientContext> = HelpClientContextSchema;

export const HelpPlugin = Schema.Struct({
  id: text(200),
  name: text(200),
  description: text(2_000),
  version: text(100),
  installed: Schema.Boolean,
  enabled: Schema.Boolean,
  requiresConnection: Schema.Boolean,
  connectionState: text(100),
  capabilities: Schema.Array(
    Schema.Struct({
      id: text(200),
      name: text(200),
      description: text(2_000),
      access: text(100),
      enabled: Schema.Boolean,
      granted: Schema.Boolean,
      available: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(100)),
  tools: Schema.Array(
    Schema.Struct({
      name: text(200),
      description: text(2_000),
      effect: Schema.Literals(["read", "write"]),
      available: Schema.Boolean,
      capabilities: Schema.optionalKey(Schema.Array(text(200)).check(Schema.isMaxLength(100))),
    }),
  ).check(Schema.isMaxLength(150)),
  skills: Schema.Array(
    Schema.Struct({
      name: text(200),
      description: text(2_000),
      enabled: Schema.Boolean,
      available: Schema.Boolean,
      capabilities: Schema.optionalKey(Schema.Array(text(200)).check(Schema.isMaxLength(100))),
    }),
  ).check(Schema.isMaxLength(100)),
  detailsOmitted: Schema.Boolean,
});
export type HelpPlugin = typeof HelpPlugin.Type;

export const HelpKnowledge = Schema.Struct({
  settings: HelpSettingsSnapshot,
  pluginsStatus: Schema.Literals(["reported", "unavailable"]),
  plugins: Schema.Array(HelpPlugin).check(Schema.isMaxLength(100)),
  pluginsOmittedCount: NonNegativeInt,
  documentation: Schema.Array(
    Schema.Struct({ title: text(300), path: text(300), content: text(16_000) }),
  ).check(Schema.isMaxLength(8)),
  documentationStatus: Schema.Literals(["available", "unavailable"]),
});
export type HelpKnowledge = typeof HelpKnowledge.Type;

/** An allowlisted host snapshot; provider authentication is cached discovery, not a live check. */
const HelpContextSchema = Schema.Struct({
  capturedAt: timestamp,
  environmentId: EnvironmentId,
  environmentName: text(200),
  version: text(100),
  platform: text(100),
  mode: text(100),
  paths: Schema.Array(Schema.Struct({ label: text(100), path: text(2_000) })).check(
    Schema.isMaxLength(8),
  ),
  providers: Schema.Array(
    Schema.Struct({
      id: text(200),
      name: text(200),
      driver: text(100),
      enabled: Schema.Boolean,
      status: text(100),
      authenticated: Schema.NullOr(Schema.Boolean),
    }),
  ).check(Schema.isMaxLength(100)),
  modelLabel: text(300),
  knowledge: Schema.optionalKey(HelpKnowledge),
  client: Schema.optionalKey(HelpClientContext),
  diagnostics: Schema.Struct({
    recordCount: NonNegativeInt,
    failureCount: NonNegativeInt,
    slowSpanCount: NonNegativeInt,
    partial: Schema.Boolean,
    recentFailures: Schema.Array(
      Schema.Struct({ operation: text(100), category: text(100), occurredAt: timestamp }),
    ).check(Schema.isMaxLength(5)),
  }),
});
export interface HelpContext {
  readonly capturedAt: string;
  readonly environmentId: EnvironmentId;
  readonly environmentName: string;
  readonly version: string;
  readonly platform: string;
  readonly mode: string;
  readonly paths: readonly { readonly label: string; readonly path: string }[];
  readonly providers: readonly {
    readonly id: string;
    readonly name: string;
    readonly driver: string;
    readonly enabled: boolean;
    readonly status: string;
    readonly authenticated: boolean | null;
  }[];
  readonly modelLabel: string;
  readonly knowledge?: HelpKnowledge;
  readonly client?: HelpClientContext;
  readonly diagnostics: {
    readonly recordCount: number;
    readonly failureCount: number;
    readonly slowSpanCount: number;
    readonly partial: boolean;
    readonly recentFailures: readonly {
      readonly operation: string;
      readonly category: string;
      readonly occurredAt: string;
    }[];
  };
}
type HelpContextEncoded = Omit<HelpContext, "environmentId"> & { readonly environmentId: string };
export const HelpContext: Schema.Codec<HelpContext, HelpContextEncoded> = HelpContextSchema;

const HelpAskInputSchema = Schema.Struct({
  messages: Schema.Array(HelpMessage).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  client: Schema.optionalKey(HelpClientContext),
});
export interface HelpAskInput {
  readonly messages: readonly HelpMessage[];
  readonly client?: HelpClientContext;
}
export const HelpAskInput: Schema.Codec<HelpAskInput> = HelpAskInputSchema;
const HelpAskResultSchema = Schema.Struct({ answer: text(16_000), context: HelpContext });
export interface HelpAskResult {
  readonly answer: string;
  readonly context: HelpContext;
}
export const HelpAskResult: Schema.Codec<
  HelpAskResult,
  { readonly answer: string; readonly context: HelpContextEncoded }
> = HelpAskResultSchema;

export const HelpErrorCode = Schema.Literals([
  "unavailable",
  "unsupported",
  "busy",
  "timeout",
  "generation_failed",
  "invalid_request",
]);
export type HelpErrorCode = typeof HelpErrorCode.Type;

/** Fixed safe wire messages deliberately exclude provider errors and their causes. */
export class HelpError extends Schema.TaggedError<HelpError>()("HelpError", {
  code: HelpErrorCode,
}) {
  override get message(): string {
    switch (this.code) {
      case "unavailable":
        return "Help is unavailable. Check the text generation model in Settings > General.";
      case "unsupported":
        return "The configured provider cannot run Help with tools disabled. The environment snapshot is still available.";
      case "busy":
        return "Help is busy. Try again after the current request finishes.";
      case "timeout":
        return "Help took too long to respond. Try again.";
      case "generation_failed":
        return "Help could not generate an answer. Check the provider in Settings > Providers and try again.";
      case "invalid_request":
        return "Send a Help conversation with at most 20 messages of 8,000 characters each, ending with a question.";
    }
  }
}
