import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

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
        limit: { type: "integer", allOf: [{ minimum: 1, maximum: 25 }] },
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
});
