import * as Schema from "effect/Schema";

// Effect's empty Struct currently accepts arrays in its encoded form. This
// record represents the MCP/Codex empty argument object exactly.
export const EmptyIntegrationToolInput = Schema.Record(Schema.String, Schema.Never);

/**
 * A provider tool has one executable input contract. The same Effect Schema is
 * decoded before provider invocation and rendered as JSON Schema for MCP/Codex,
 * so the advertised contract cannot drift from the server-side guard.
 */
export interface IntegrationProviderTool {
  readonly name: string;
  readonly description: string;
  readonly input: Schema.Decoder<unknown>;
  readonly readOnly: boolean;
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
  readonly openWorld: boolean;
}

type ToolInputDecoder = (input: unknown) => Promise<unknown>;
const toolInputDecoders = new WeakMap<object, ToolInputDecoder>();

export function integrationToolJsonSchema(
  definition: IntegrationProviderTool,
): Readonly<Record<string, unknown>> {
  const document = Schema.toJsonSchemaDocument(definition.input);
  const schema = document.schema as Readonly<Record<string, unknown>>;
  return Object.keys(document.definitions).length > 0
    ? { ...schema, $defs: document.definitions }
    : schema;
}

export function decodeIntegrationToolInput(
  definition: IntegrationProviderTool,
  input: unknown,
): Promise<unknown> {
  const key = definition.input as object;
  let decode = toolInputDecoders.get(key);
  if (!decode) {
    // Provider schemas are dynamic; cache the compiled decoder once per schema instance.
    const compiled = Schema.decodeUnknownPromise(definition.input);
    decode = (value) =>
      compiled(value, {
        errors: "all",
        onExcessProperty: "error",
      });
    toolInputDecoders.set(key, decode);
  }
  return decode(input);
}
