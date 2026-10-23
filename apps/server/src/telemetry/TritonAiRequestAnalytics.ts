import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { makeTritonAiClientHeaders, TRITONAI_CLIENT_VERSION } from "../tritonAiClientHeaders.ts";
import { getAnonymousInstallId } from "./Identify.ts";

type RequestPurpose =
  | "chat"
  | "generation"
  | "help"
  | "ideas"
  | "memory"
  | "image"
  | "voice"
  | "catalog"
  | "management";

// Standalone provider probes can run without the server's optional analytics layer.
export class TritonAiRequestAnalytics extends Context.Reference<{
  readonly headers: (purpose: RequestPurpose) => Readonly<Record<string, string>>;
}>("t3/telemetry/TritonAiRequestAnalytics", {
  defaultValue: () => ({ headers: makeTritonAiClientHeaders }),
}) {}

const make = Effect.gen(function* () {
  const enabled = yield* Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(
    Config.withDefault(true),
    Effect.orElseSucceed(() => false),
  );
  if (!enabled) return TritonAiRequestAnalytics.of({ headers: makeTritonAiClientHeaders });

  // Read once at startup. Attribution must not stall model requests if storage is unavailable.
  const installId = yield* getAnonymousInstallId.pipe(
    Effect.timeoutOption("1 second"),
    Effect.map(Option.flatten),
  );
  return TritonAiRequestAnalytics.of({
    headers: (purpose) => ({
      ...makeTritonAiClientHeaders(),
      "x-litellm-tags": [
        "app:tritonai-harness",
        `version:${TRITONAI_CLIENT_VERSION}`,
        `purpose:${purpose}`,
      ].join(","),
      ...(Option.isSome(installId)
        ? { "x-litellm-end-user-id": `harness-install:${installId.value}` }
        : {}),
    }),
  });
});

export const layer = Layer.effect(TritonAiRequestAnalytics, make);
