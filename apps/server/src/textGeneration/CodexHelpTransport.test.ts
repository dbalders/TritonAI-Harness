import { describe, expect, it } from "vite-plus/test";
import { codexHelpTransport } from "./CodexHelpTransport.ts";

const onprem = {
  name: "On-premises",
  base_url: "http://127.0.0.1:4444/v1",
  env_key: "HELP_ONPREM_KEY",
  wire_api: "responses",
  requires_openai_auth: false,
};

describe("Help effective transport", () => {
  it("retains only the selected custom endpoint and transport fields", () => {
    const result = codexHelpTransport({
      model_provider: "onprem",
      model_providers: { onprem, ignored: { http_headers: { Authorization: "private" } } },
      developer_instructions: "PRIVATE CONFIG INSTRUCTIONS",
      mcp_servers: { private: { command: "must-not-run" } },
    });
    expect(result).toEqual({
      provider: "onprem",
      custom: true,
      args: Object.entries(onprem).flatMap(([key, value]) => [
        "--config",
        `model_providers.onprem.${key}=${JSON.stringify(value)}`,
      ]),
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|Authorization|must-not-run/);
  });

  it.each([
    {},
    { model_provider: null },
    {
      model_provider: "openai",
      model_providers: { ignored: { http_headers: { Authorization: "private" } } },
    },
  ])("recognizes the built-in default only after effective config discovery: %j", (config) => {
    expect(codexHelpTransport(config)).toEqual({ provider: "openai", custom: false, args: [] });
  });

  it("treats an openai-named override as custom so it never receives native grants", () => {
    const result = codexHelpTransport({
      model_provider: "openai",
      model_providers: { openai: onprem },
    });
    expect(result?.custom).toBe(true);
    expect(result?.args).toContain('model_providers.openai.base_url="http://127.0.0.1:4444/v1"');
  });

  it("accepts absent optional transport fields serialized as null by Codex", () => {
    const result = codexHelpTransport({
      model_provider: "onprem",
      model_providers: {
        onprem: {
          ...onprem,
          auth: null,
          http_headers: null,
          env_http_headers: null,
          experimental_bearer_token: null,
          request_max_retries: null,
          supports_standalone_web_search: false,
        },
      },
    });
    expect(result).toEqual(
      codexHelpTransport({ model_provider: "onprem", model_providers: { onprem } }),
    );
  });

  it("recognizes canonical backend URLs materialized by Codex defaults", () => {
    expect(
      codexHelpTransport({
        model_provider: "openai",
        openai_base_url: null,
        chatgpt_base_url: "https://chatgpt.com/backend-api/",
      }),
    ).toEqual({ provider: "openai", custom: false, args: [] });
  });

  it.each([
    null,
    [],
    { model_provider: 42 },
    { model_provider: "custom.with.dots" },
    { model_provider: "unknown" },
    { model_provider: "onprem", model_providers: { onprem: { name: "missing URL" } } },
    {
      model_provider: "onprem",
      model_providers: { onprem: { ...onprem, http_headers: { Authorization: "private" } } },
    },
    { model_provider: "onprem", model_providers: { onprem: { ...onprem, env_key: 42 } } },
    { model_provider: "openai", chatgpt_base_url: "https://different.invalid" },
    { model_provider: "openai", openai_base_url: "https://different.invalid" },
  ])("fails closed when a transport cannot be reproduced safely: %j", (config) => {
    expect(codexHelpTransport(config)).toBeNull();
  });
});
