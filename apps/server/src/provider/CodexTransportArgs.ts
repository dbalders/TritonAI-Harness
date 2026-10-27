import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { codexExecLaunchArgs } from "./codexLaunchArgs.ts";

export function parseCodexTransportArgs(launchArgs: string | undefined) {
  const fail = () => new Error("The selected Codex transport cannot be isolated.");
  // undefined means absent; null means a selector we cannot safely interpret.
  let selectedProvider: string | null | undefined;
  // An unrelated transport must not change native authentication or be queried here.
  const providerTransports = new Map<string, string[]>();
  {
    // These switches change the configuration source or endpoint. Dropping
    // them could turn an unsupported route into an implicit native request.
    if (
      tokenizeCliArgs(launchArgs ?? "").some(
        (arg) =>
          ["--profile", "-p", "--oss", "--local-provider", "--remote", "--cd", "-C"].some(
            (flag) => arg === flag || arg.startsWith(flag + "="),
          ) || /^-(?:p|C).+/.test(arg),
      )
    )
      throw fail();
    const args = codexExecLaunchArgs(launchArgs);
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      const value =
        arg === "--config" || arg === "-c"
          ? args[++index]
          : arg?.startsWith("--config=")
            ? arg.slice("--config=".length)
            : arg?.startsWith("-c=")
              ? arg.slice("-c=".length)
              : undefined;
      if (value === undefined) continue;
      const separator = value.indexOf("=");
      if (separator < 0) throw fail();
      const key = value.slice(0, separator).trim();
      const configValue = value.slice(separator + 1).trim();
      if (/^(?:profile|profiles|oss_provider|codex_home)(?:\.|$)/.test(key)) throw fail();
      if (key === "model_provider") {
        // Codex parses TOML, falling back to a raw string after shell
        // tokenization. Admit only unambiguous provider IDs in either
        // form; escaped/structured selectors fail closed. Later overrides win.
        const selector =
          /^(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|([A-Za-z_][A-Za-z0-9_-]*))$/.exec(configValue);
        selectedProvider =
          selector && !(selector[3] && /^(?:true|false|inf|nan)$/.test(selector[3]))
            ? (selector[1] ?? selector[2] ?? selector[3] ?? null)
            : null;
        continue;
      }
      // A dotted override replaces a scalar selector with a table. A
      // later root assignment can replace it again, so validate only last.
      if (key.startsWith("model_provider.")) {
        selectedProvider = null;
        continue;
      }
      // Do not silently drop alternate endpoint settings and then reuse
      // native credentials. They are outside the isolated transport allowlist.
      if (/^(?:openai_base_url|chatgpt_base_url)(?:\.|$)/.test(key)) throw fail();
      const isProviderTransport = key === "model_providers" || key.startsWith("model_providers.");
      const transport =
        /^model_providers\.([A-Za-z0-9_-]+)\.(?:name|base_url|env_key|wire_api|requires_openai_auth|supports_websockets|model_catalog_url)$/.exec(
          key,
        );
      if (isProviderTransport && !transport) throw fail();
      if (transport) {
        const provider = transport[1]!;
        const overrides = providerTransports.get(provider) ?? [];
        overrides.push("--config", `${key}=${configValue}`);
        providerTransports.set(provider, overrides);
      }
    }
  }

  if (selectedProvider === null) throw fail();
  if (selectedProvider === undefined && providerTransports.size > 0) throw fail();
  return { selectedProvider, providerTransports };
}
