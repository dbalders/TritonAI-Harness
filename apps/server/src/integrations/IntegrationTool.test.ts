// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  decodeIntegrationToolInput,
  EmptyIntegrationToolInput,
  type IntegrationProviderTool,
  integrationToolJsonSchema,
} from "./IntegrationTool.ts";

const definition: IntegrationProviderTool = {
  name: "fixture.items.list",
  description: "List fixture items.",
  input: Schema.Struct({
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 }))),
  }),
  readOnly: true,
  openWorld: false,
};

describe("integration provider tool contracts", () => {
  it("represents empty arguments as an object, never an array", async () => {
    const empty = { ...definition, input: EmptyIntegrationToolInput };
    expect(integrationToolJsonSchema(empty)).toEqual({
      type: "object",
      additionalProperties: false,
    });
    await expect(decodeIntegrationToolInput(empty, {})).resolves.toEqual({});
    await expect(decodeIntegrationToolInput(empty, [])).rejects.toBeDefined();
  });

  it("derives the advertised JSON Schema from the executable input schema", () => {
    expect(integrationToolJsonSchema(definition)).toMatchObject({
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 25 },
      },
      additionalProperties: false,
    });
  });

  it("decodes valid input before invocation", async () => {
    await expect(decodeIntegrationToolInput(definition, { limit: 5 })).resolves.toEqual({
      limit: 5,
    });
  });

  it("rejects input that violates the advertised contract", async () => {
    await expect(decodeIntegrationToolInput(definition, { limit: 100 })).rejects.toBeDefined();
    await expect(
      decodeIntegrationToolInput(definition, { limit: 5, ignored: true }),
    ).rejects.toBeDefined();
    await expect(decodeIntegrationToolInput(definition, "not an object")).rejects.toBeDefined();
  });

  it("decodes constrained plugin schemas created by a separate Effect runtime", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-schema-runtime-"));
    try {
      const effectRoot = NodePath.dirname(
        NodeURL.fileURLToPath(import.meta.resolve("effect/package.json")),
      );
      const copy = NodePath.join(root, "effect");
      await NodeFSP.cp(effectRoot, copy, { recursive: true });
      await NodeFSP.symlink(
        NodePath.dirname(effectRoot),
        NodePath.join(root, "node_modules"),
        "junction",
      );
      const pluginSchema: typeof Schema = await import(
        NodeURL.pathToFileURL(NodePath.join(copy, "dist/Schema.js")).href
      );
      const foreign = {
        ...definition,
        input: pluginSchema.Struct({
          start: pluginSchema.optionalKey(pluginSchema.String.check(pluginSchema.isMaxLength(64))),
          limit: pluginSchema.optionalKey(
            pluginSchema.Int.check(pluginSchema.isBetween({ minimum: 1, maximum: 25 })),
          ),
        }),
      };
      const input = { start: "2026-09-16T00:00:00-07:00", limit: 5 };
      await expect(decodeIntegrationToolInput(foreign, input)).resolves.toEqual(input);
      await expect(decodeIntegrationToolInput(foreign, {})).resolves.toEqual({});
      await expect(
        decodeIntegrationToolInput(foreign, { start: "x".repeat(65) }),
      ).rejects.toBeDefined();
      await expect(decodeIntegrationToolInput(foreign, { limit: 26 })).rejects.toBeDefined();
      await expect(decodeIntegrationToolInput(foreign, null)).rejects.toBeDefined();
      await expect(
        decodeIntegrationToolInput(foreign, { ...input, extra: true }),
      ).rejects.toBeDefined();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
