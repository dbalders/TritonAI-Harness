import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

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

export function prepareIntegrationToolInput(definition: IntegrationProviderTool): void {
  const key = definition.input as object;
  if (toolInputDecoders.has(key)) return;
  const compiled = Schema.decodeUnknownPromise(definition.input);
  toolInputDecoders.set(key, (value) =>
    compiled(value, {
      errors: "all",
      onExcessProperty: "error",
    }),
  );
}

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
    prepareIntegrationToolInput(definition);
    decode = toolInputDecoders.get(key)!;
  }
  return decode(input);
}

const MAX_INPUT_ISSUES = 5;
const MAX_INPUT_ISSUES_TEXT_LENGTH = 1_500;
const MAX_INPUT_PATH_KEY_LENGTH = 64;

// Tool input is decoded without `reportInput`, so issues carry no submitted values and these
// messages describe only paths and schema expectations.
const formatInputIssues = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) => {
    switch (issue._tag) {
      case "UnexpectedKey":
        return "unexpected property";
      case "MissingKey":
        return "missing required property";
      default:
        return SchemaIssue.defaultLeafHook(issue);
    }
  },
});

function formatInputPath(path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>): string {
  return path
    .map((segment, index) => {
      const key = typeof segment === "object" ? segment.key : segment;
      if (typeof key === "number") return `[${key}]`;
      const name = String(key);
      const boundedName =
        name.length > MAX_INPUT_PATH_KEY_LENGTH
          ? `${name.slice(0, MAX_INPUT_PATH_KEY_LENGTH)}…`
          : name;
      if (!/^[A-Za-z_$][\w$]*$/u.test(boundedName)) return `[${JSON.stringify(boundedName)}]`;
      return index === 0 ? boundedName : `.${boundedName}`;
    })
    .join("");
}

/**
 * Summarize why tool input failed its declared schema for the agent that sent it: failing paths
 * and expected shapes, bounded in count and length. Returns undefined for non-schema errors.
 */
export function describeIntegrationToolInputIssues(error: unknown): string | undefined {
  if (!Schema.isSchemaError(error)) return undefined;
  const issues = formatInputIssues(error.issue).issues;
  if (issues.length === 0) return undefined;
  const lines = issues
    .slice(0, MAX_INPUT_ISSUES)
    .map(({ path, message }) =>
      path && path.length > 0 ? `${formatInputPath(path)}: ${message}` : message,
    );
  if (issues.length > MAX_INPUT_ISSUES) {
    lines.push(`${issues.length - MAX_INPUT_ISSUES} more issue(s) omitted`);
  }
  const text = lines.join("; ").trim();
  return text.length > MAX_INPUT_ISSUES_TEXT_LENGTH
    ? `${text.slice(0, MAX_INPUT_ISSUES_TEXT_LENGTH - 1)}…`
    : text;
}
