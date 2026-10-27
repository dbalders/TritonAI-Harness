import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import type { JsonSchema as PluginJsonSchema } from "@t3tools/shared/pluginSdkContract";
import type * as JsonSchema from "effect/JsonSchema";
import * as Schema from "effect/Schema";
import type * as SchemaIssue from "effect/SchemaIssue";
import { vettedIntegrationToolInputIssue } from "../IntegrationTool.ts";

// Agents see these issues verbatim, so they must never carry submitted values. Ajv messages and
// the params read below come from the schema; instance paths and `additionalProperties` params
// may name submitted property keys, which the formatter caps. That holds only for the Ajv
// configuration in compileJsonSchema: discriminator and `$data` stay disabled, no custom keywords
// or formats are added, and strict mode rejects unknown formats at compile time. Other params,
// such as `propertyNames`' submitted `propertyName`, are never read.
function pluginSchemaIssue(error: ErrorObject): SchemaIssue.Issue {
  const path = error.instancePath
    .split("/")
    .slice(1)
    .map((token) => {
      const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
      return /^(?:0|[1-9]\d*)$/u.test(key) ? Number(key) : key;
    });
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "additionalProperties":
      return vettedIntegrationToolInputIssue(
        [...path, String(params.additionalProperty)],
        "unexpected property",
      );
    case "unevaluatedProperties":
      return vettedIntegrationToolInputIssue(
        [...path, String(params.unevaluatedProperty)],
        "unexpected property",
      );
    case "required":
      return vettedIntegrationToolInputIssue(
        [...path, String(params.missingProperty)],
        "missing required property",
      );
    case "enum":
      return vettedIntegrationToolInputIssue(
        path,
        `Expected ${(params.allowedValues as ReadonlyArray<unknown>).map((value) => JSON.stringify(value)).join(" | ")}`,
      );
    case "const":
      return vettedIntegrationToolInputIssue(
        path,
        `Expected ${JSON.stringify(params.allowedValue)}`,
      );
    default:
      return vettedIntegrationToolInputIssue(path, error.message ?? "invalid value");
  }
}

export function compilePluginJsonSchema(schema: PluginJsonSchema): Schema.Decoder<unknown> {
  // Plugin contracts are draft-2020-12 JSON Schema. Validate that exact document:
  // Effect's best-effort importer cannot represent all patternProperties scopes.
  const validator = new Ajv2020({
    allErrors: true,
    strict: true,
    strictTypes: false,
    strictTuples: false,
    strictRequired: false,
    allowMatchingProperties: true,
  });
  const validate = validator.compile(schema);
  if ("$async" in validate && validate.$async) {
    throw new Error("Plugin schemas must validate synchronously.");
  }
  // Any keeps this JSON-native check on the encoded side of Effect's codec;
  // Unknown would derive a separate JSON codec and drop the advertised check.
  return Schema.Any.check(
    Schema.makeFilter<unknown>(
      (input) =>
        validate(input) ||
        (validate.errors?.length ? validate.errors.map(pluginSchemaIssue) : "Invalid input."),
      { toJsonSchema: () => schema as JsonSchema.JsonSchema },
    ),
  );
}
