import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { withCodexHelpOwnerClient } from "./CodexHelpAuthOwner.ts";

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const fields = new Set([
  "name",
  "base_url",
  "env_key",
  "wire_api",
  "requires_openai_auth",
  "supports_websockets",
  "model_catalog_url",
]);

/** Extract only a proved transport; configuration instructions and opaque auth stay on the host. */
export function codexHelpTransport(config: unknown) {
  if (!isRecord(config)) return null;
  if (
    config.openai_base_url != null &&
    (typeof config.openai_base_url !== "string" ||
      !/^https:\/\/api\.openai\.com\/v1\/?$/.test(config.openai_base_url))
  )
    return null;
  if (
    config.chatgpt_base_url != null &&
    (typeof config.chatgpt_base_url !== "string" ||
      !/^https:\/\/chatgpt\.com\/backend-api\/?$/.test(config.chatgpt_base_url))
  )
    return null;
  const provider = config.model_provider ?? "openai";
  if (typeof provider !== "string" || !/^[A-Za-z0-9_-]+$/.test(provider)) return null;
  const providers = config.model_providers;
  if (providers != null && !isRecord(providers)) return null;
  const transport =
    providers && Object.hasOwn(providers, provider) ? providers[provider] : undefined;
  if (transport === undefined)
    return provider === "openai" ? { provider, custom: false, args: [] as string[] } : null;
  if (
    !isRecord(transport) ||
    !Object.entries(transport).every(
      ([key, value]) =>
        fields.has(key) ||
        value === null ||
        (key === "supports_standalone_web_search" && value === false),
    )
  )
    return null;
  if (typeof transport.base_url !== "string" || transport.base_url.trim() === "") return null;
  const args: string[] = [];
  for (const [key, value] of Object.entries(transport)) {
    if (value === null || key === "supports_standalone_web_search") continue;
    if (key === "requires_openai_auth" || key === "supports_websockets") {
      if (typeof value !== "boolean") return null;
    } else if (typeof value !== "string") return null;
    args.push("--config", `model_providers.${provider}.${key}=${JSON.stringify(value)}`);
  }
  return { provider, custom: true, args };
}

export const readCodexHelpTransport = Effect.fn("readCodexHelpTransport")(function* (input: {
  readonly binary: string;
  readonly home: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly configArgs: ReadonlyArray<string>;
}) {
  return yield* withCodexHelpOwnerClient(input, (client) =>
    client
      .request("config/read", { includeLayers: false })
      .pipe(Effect.map((response) => codexHelpTransport(response.config))),
  );
});
