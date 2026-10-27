import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  describeIntegrationToolInputIssues,
  decodeIntegrationToolInput,
} from "../IntegrationTool.ts";
import { compilePluginJsonSchema } from "./schema.ts";

const tool = (input: Parameters<typeof compilePluginJsonSchema>[0]) => ({
  name: "fixture.read",
  description: "Fixture",
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: false,
  input: compilePluginJsonSchema(input),
});

it("preserves Unicode patterns in tool values and property names", async () => {
  const value = tool({
    type: "object",
    properties: { topic: { type: "string", pattern: "^[^\\p{Cc}\\s]+$" } },
    required: ["topic"],
    additionalProperties: false,
  });
  for (const topic of ["ElsCzc5cQpan2Ucb", "日本語", "😀"])
    await expect(decodeIntegrationToolInput(value, { topic })).resolves.toEqual({ topic });
  for (const topic of ["", "has space", "tab\t", "control\u0085", "null\u0000"])
    await expect(decodeIntegrationToolInput(value, { topic })).rejects.toThrow();
  const properties = tool({
    type: "object",
    properties: {},
    patternProperties: { "^\\p{L}+$": { type: "string" } },
    additionalProperties: false,
  });
  await expect(decodeIntegrationToolInput(properties, { 日本語: "value" })).resolves.toEqual({
    日本語: "value",
  });
  for (const invalid of [{ 日本語: 123 }, { "123": "value" }, []])
    await expect(decodeIntegrationToolInput(properties, invalid)).rejects.toThrow();
});

it("reports failing paths and expectations without submitted values", async () => {
  const input = tool({
    type: "object",
    properties: {
      operations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["updateNodeParameters", "setNodeParameter"] },
            nodeName: { type: "string" },
            parameters: { type: "object", additionalProperties: {} },
          },
          required: ["type", "nodeName"],
          additionalProperties: false,
        },
      },
    },
    required: ["operations"],
    additionalProperties: false,
  });
  const error = await decodeIntegrationToolInput(input, {
    operations: [{ type: "updateNode", changes: { parameters: { jsCode: "SECRET_CODE_MARKER" } } }],
  }).then(
    () => expect.unreachable("Invalid input must be rejected"),
    (failure: unknown) => failure,
  );
  const issues = describeIntegrationToolInputIssues(error);
  expect(issues).toBe(
    'operations[0].nodeName: missing required property; operations[0].changes: unexpected property; operations[0].type: Expected "updateNodeParameters" | "setNodeParameter"',
  );
  expect(issues).not.toContain("SECRET_CODE_MARKER");
  const valid = {
    operations: [{ type: "updateNodeParameters", nodeName: "X", parameters: { jsCode: "code" } }],
  };
  await expect(decodeIntegrationToolInput(input, valid)).resolves.toEqual(valid);
});

it("names invalid property keys without revealing their values", async () => {
  const input = tool({
    type: "object",
    properties: {
      labels: {
        type: "object",
        propertyNames: { pattern: "^[a-z]+$" },
        additionalProperties: { type: "number" },
      },
    },
    additionalProperties: false,
  });
  const error = await decodeIntegrationToolInput(input, {
    labels: { SECRET_KEY: "SECRET_VALUE" },
  }).then(
    () => expect.unreachable("Invalid input must be rejected"),
    (failure: unknown) => failure,
  );
  expect(describeIntegrationToolInputIssues(error)).toContain("labels.SECRET_KEY: must be number");
  expect(describeIntegrationToolInputIssues(error)).not.toContain("SECRET_VALUE");
});

it("keeps strict empty object schemas strict for tools and configuration", async () => {
  const schema = { type: "object", properties: {}, additionalProperties: false };
  const input = tool(schema);
  await expect(decodeIntegrationToolInput(input, {})).resolves.toEqual({});
  const configuration = Schema.decodeUnknownPromise(compilePluginJsonSchema(schema));
  await expect(configuration({})).resolves.toEqual({});
  for (const invalid of [[], { extra: true }]) {
    await expect(decodeIntegrationToolInput(input, invalid)).rejects.toThrow();
    await expect(configuration(invalid)).rejects.toThrow();
  }
});

it("resolves schema pointers without treating instance defaults as schemas", async () => {
  const valid = compilePluginJsonSchema({
    type: "object",
    additionalProperties: false,
    $defs: { label: { type: "string" } },
    properties: {
      pattern: { $ref: "#/%24defs/label" },
      metadata: { type: "object", default: { $id: "instance-data", $ref: "not-a-schema" } },
    },
  });
  await expect(Schema.decodeUnknownPromise(valid)({ pattern: "fixture" })).resolves.toEqual({
    pattern: "fixture",
  });
});
