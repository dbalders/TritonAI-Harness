import * as NodeAssert from "node:assert/strict";

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import type { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../../processRunner.ts";

import {
  buildTritonAiCodexModelCatalog,
  managedCodexModelCatalogFileName,
  materializeTritonAiCodexModelCatalog,
} from "./CodexModelCatalog.ts";

const bundledCatalog = JSON.stringify({
  models: [
    {
      slug: "gpt-5.2",
      display_name: "GPT-5.2",
      description: "Bundled model",
      priority: 29,
      visibility: "list",
      base_instructions: "You are GPT-5.2 running in the Codex CLI.\n\nKeep changes focused.",
      model_messages: { instructions_template: "Use GPT-5.2 instructions." },
      input_modalities: ["text", "image"],
      context_window: 123_000,
      max_context_window: 124_000,
      truncation_policy: { mode: "tokens", limit: 12_345 },
      web_search_tool_type: "text",
      supports_search_tool: true,
      use_responses_lite: false,
    },
    {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      priority: 7,
      input_modalities: ["text", "image"],
    },
  ],
});

it.layer(NodeServices.layer)("CodexModelCatalog materialization", (it) => {
  const metadataWithoutModalities: Array<CodexSettings["customModelMetadata"]> = [
    { "gpt-6.1-sol": { name: "GPT-6.1 Sol" } },
    { "gpt-6.1-sol": { name: "GPT-6.1 Sol", capabilities: { inputModalities: [] } } },
  ];
  // regression: #421 fix(codex): contain Stop commands and restore managed Auto approvals
  it.effect.each(metadataWithoutModalities)(
    "refreshes a managed catalog without explicit modalities: %j",
    (customModelMetadata) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fs.makeTempDirectoryScoped({ prefix: "managed-cloud-catalog-" });
        const filePath = path.join(homePath, managedCodexModelCatalogFileName("codex_frontier"));
        const staleCatalog = JSON.stringify({ models: [{ slug: "codex-auto-review" }] });
        yield* fs.writeFileString(filePath, staleCatalog);
        const cachePath = path.join(homePath, "models_cache.json");
        yield* fs.writeFileString(cachePath, staleCatalog);
        let reads = 0;
        const runner = ProcessRunner.ProcessRunner.of({
          run: (input) =>
            Effect.sync(() => {
              reads += 1;
              NodeAssert.equal(input.command, "/fixture/codex");
              NodeAssert.deepStrictEqual(input.args, ["debug", "models", "--bundled"]);
              NodeAssert.deepStrictEqual(input.env, { CODEX_HOME: homePath });
              const catalog = JSON.parse(bundledCatalog);
              catalog.models.push({ slug: "codex-auto-review" });
              return {
                code: ChildProcessSpawner.ExitCode(0),
                stdout: JSON.stringify(catalog),
                stderr: "",
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              };
            }),
        });
        const input = {
          binaryPath: "/fixture/codex",
          homePath,
          catalogKey: "codex_frontier",
          environment: { CODEX_HOME: homePath },
          customModelMetadata,
          managedGateway: true,
        };
        const result = yield* materializeTritonAiCodexModelCatalog(input).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, runner),
        );

        NodeAssert.equal(result, filePath);
        NodeAssert.equal(reads, 1);
        NodeAssert.deepStrictEqual(
          JSON.parse(yield* fs.readFileString(filePath)),
          JSON.parse(bundledCatalog),
        );
        NodeAssert.equal(yield* fs.readFileString(cachePath), staleCatalog);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "fails rather than reusing a stale managed catalog when the bundled catalog is invalid",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fs.makeTempDirectoryScoped({ prefix: "invalid-managed-catalog-" });
        const filePath = path.join(homePath, managedCodexModelCatalogFileName("codex_frontier"));
        const staleCatalog = JSON.stringify({ models: [{ slug: "codex-auto-review" }] });
        yield* fs.writeFileString(filePath, staleCatalog);
        const input = {
          binaryPath: "/fixture/codex",
          homePath,
          catalogKey: "codex_frontier",
          environment: {},
          customModelMetadata: {},
          managedGateway: true,
        };
        const error = yield* materializeTritonAiCodexModelCatalog(input).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: () =>
              Effect.succeed({
                code: ChildProcessSpawner.ExitCode(0),
                stdout: "{}",
                stderr: "",
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              }),
          }),
          Effect.flip,
        );

        NodeAssert.equal(error.operation, "buildCatalog");
        NodeAssert.equal(yield* fs.readFileString(filePath), staleCatalog);
      }).pipe(Effect.scoped),
  );

  it.effect("leaves a personal catalog untouched without explicit modalities", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homePath = yield* fs.makeTempDirectoryScoped({ prefix: "personal-catalog-" });
      const filePath = path.join(homePath, managedCodexModelCatalogFileName("codex_personal"));
      yield* fs.writeFileString(filePath, "existing personal catalog");
      const result = yield* materializeTritonAiCodexModelCatalog({
        binaryPath: "/fixture/codex",
        homePath,
        catalogKey: "codex_personal",
        environment: {},
        customModelMetadata: { "personal-model": { name: "Personal model" } },
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () => Effect.die("Personal providers must not read a bundled catalog here"),
        }),
      );

      NodeAssert.equal(result, undefined);
      NodeAssert.equal(yield* fs.readFileString(filePath), "existing personal catalog");
    }).pipe(Effect.scoped),
  );
});

describe("CodexModelCatalog", () => {
  it("adds only custom models with explicit input modality metadata", () => {
    const result = JSON.parse(
      buildTritonAiCodexModelCatalog(bundledCatalog, {
        "api-glm-5.3": {
          name: "GLM 5.3",
          capabilities: { inputModalities: ["text"] },
        },
        "api-glm-5.3-flash": {
          name: "GLM 5.3 Flash",
          capabilities: { inputModalities: ["text", "image"] },
        },
        "custom-with-unknown-modalities": { name: "Unknown" },
      }),
    ) as { models: Array<Record<string, unknown>> };

    NodeAssert.deepStrictEqual(
      result.models.map((model) => model.slug),
      ["gpt-5.2", "gpt-5.5", "api-glm-5.3", "api-glm-5.3-flash"],
    );
    const glm = result.models.find((model) => model.slug === "api-glm-5.3");
    NodeAssert.deepStrictEqual(glm?.input_modalities, ["text"]);
    NodeAssert.equal(glm?.visibility, "hide");
    NodeAssert.match(
      String(glm?.base_instructions),
      /^You are a coding assistant running in TritonAI Harness\./,
    );
    NodeAssert.doesNotMatch(String(glm?.base_instructions), /GPT-5\.2/);
    NodeAssert.match(String(glm?.base_instructions), /Keep changes focused\.$/);
    NodeAssert.match(String(glm?.base_instructions), /current turn's runtime information/);
    NodeAssert.match(String(glm?.base_instructions), /cannot verify the selected model/);
    NodeAssert.deepStrictEqual(result.models[0], JSON.parse(bundledCatalog).models[0]);
    NodeAssert.equal(glm?.default_reasoning_level, null);
    NodeAssert.deepStrictEqual(glm?.supported_reasoning_levels, []);
    NodeAssert.equal(glm?.shell_type, "default");
    NodeAssert.equal(glm?.support_verbosity, false);
    NodeAssert.equal(glm?.apply_patch_tool_type, null);
    NodeAssert.equal(glm?.supports_parallel_tool_calls, false);
    NodeAssert.equal(glm?.web_search_tool_type, "text");
    NodeAssert.equal(glm?.supports_search_tool, false);
    NodeAssert.equal(glm?.model_messages, null);
    NodeAssert.equal(glm?.context_window, 123_000);
    NodeAssert.equal(glm?.max_context_window, 124_000);
    NodeAssert.deepStrictEqual(glm?.truncation_policy, { mode: "tokens", limit: 12_345 });

    const flash = result.models.find((model) => model.slug === "api-glm-5.3-flash");
    NodeAssert.deepStrictEqual(flash?.input_modalities, ["text", "image"]);
    NodeAssert.equal(flash?.base_instructions, glm?.base_instructions);
  });

  // regression: #297 fix(codex): review Auto-mode escalations with the chat model
  it("drops the ungranted auto-review model so Codex reviews with the chat model", () => {
    const catalog = JSON.parse(bundledCatalog) as { models: Array<Record<string, unknown>> };
    catalog.models.push({ slug: "codex-auto-review", visibility: "hide" });

    const result = JSON.parse(
      buildTritonAiCodexModelCatalog(JSON.stringify(catalog), {
        "api-glm-5.3": { name: "GLM 5.3", capabilities: { inputModalities: ["text"] } },
      }),
    ) as { models: Array<Record<string, unknown>> };

    NodeAssert.deepStrictEqual(
      result.models.map((model) => model.slug),
      ["gpt-5.2", "gpt-5.5", "api-glm-5.3"],
    );
  });

  // regression: #421 fix(codex): contain Stop commands and restore managed Auto approvals
  it("clears inherited references to the removed reviewer only for managed gateways", () => {
    const catalog = JSON.parse(bundledCatalog) as { models: Array<Record<string, unknown>> };
    catalog.models[0]!.auto_review_model_override = "codex-auto-review";
    catalog.models[1]!.auto_review_model_override = "gpt-5.2";
    catalog.models.push({ slug: "codex-auto-review", visibility: "hide" });

    for (const managedGateway of [true, false]) {
      const result = JSON.parse(
        buildTritonAiCodexModelCatalog(JSON.stringify(catalog), {}, { managedGateway }),
      ) as { models: Array<Record<string, unknown>> };

      NodeAssert.equal(
        result.models[0]?.auto_review_model_override,
        managedGateway ? null : "codex-auto-review",
      );
      NodeAssert.equal(result.models[1]?.auto_review_model_override, "gpt-5.2");
      NodeAssert.deepStrictEqual(
        result.models.map((model) => model.slug),
        ["gpt-5.2", "gpt-5.5"],
      );
    }
  });
});
