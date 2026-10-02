import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
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
  const document = Schema.toJsonSchemaDocument(definition.input, { onExcessProperty: "error" });
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
const MAX_EXPECTED_MEMBERS = 20;

const vettedInputIssueMessages = new WeakMap<SchemaIssue.Issue, string>();

/**
 * Build a filter issue whose message a host-owned validator derived only from its schema, never
 * from the validated input. Only these messages reach the agent verbatim; every other filter or
 * annotation message is reported as "invalid value".
 */
export function vettedIntegrationToolInputIssue(
  path: ReadonlyArray<PropertyKey>,
  message: string,
): SchemaIssue.Issue {
  const issue = new SchemaIssue.InvalidValue({ message });
  vettedInputIssueMessages.set(issue, message);
  return path.length > 0 ? new SchemaIssue.Pointer(path, issue) : issue;
}

function expectedFromAst(ast: SchemaAST.AST, depth = 0): string {
  switch (ast._tag) {
    case "Literal":
      return typeof ast.literal === "bigint" ? `${ast.literal}n` : JSON.stringify(ast.literal);
    case "Enum":
      return ast.enums.map(([, value]) => JSON.stringify(value)).join(" | ");
    case "Union": {
      const members = [...new Set(ast.types.map((member) => expectedFromAst(member, depth + 1)))];
      return members.length > MAX_EXPECTED_MEMBERS
        ? `${members.slice(0, MAX_EXPECTED_MEMBERS).join(" | ")} | …`
        : members.join(" | ");
    }
    case "Suspend":
      return depth < 3 ? expectedFromAst(ast.thunk(), depth + 1) : "a valid value";
    case "String":
    case "TemplateLiteral":
      return "string";
    case "Number":
      return "number";
    case "Boolean":
      return "boolean";
    case "BigInt":
      return "bigint";
    case "Symbol":
    case "UniqueSymbol":
      return "symbol";
    case "Null":
      return "null";
    case "Undefined":
    case "Void":
      return "undefined";
    case "Never":
      return "never";
    case "ObjectKeyword":
    case "Objects":
      return "object";
    case "Arrays":
      return "array";
    case "Declaration":
    case "Unknown":
    case "Any":
      return "a valid value";
  }
}

interface InputIssue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

// Built only from vetted facts: unexpected or missing keys, expected types and literals rendered
// from the schema AST, and vetted validator messages. Filter and annotation messages, and any
// input retained through `reportInput`, are never read, so submitted values cannot be echoed.
function collectInputIssues(
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey>,
  out: Array<InputIssue>,
): void {
  switch (issue._tag) {
    case "Pointer":
      return collectInputIssues(issue.issue, [...path, ...issue.path], out);
    case "Encoding":
    case "Filter":
      return collectInputIssues(issue.issue, path, out);
    case "Composite":
      for (const child of issue.issues) collectInputIssues(child, path, out);
      return;
    case "AnyOf":
      if (issue.issues.length > 0) {
        for (const child of issue.issues) collectInputIssues(child, path, out);
      } else {
        out.push({ path, message: `Expected ${expectedFromAst(issue.ast)}` });
      }
      return;
    case "InvalidType":
      out.push({ path, message: `Expected ${expectedFromAst(issue.ast)}` });
      return;
    case "MissingKey":
      out.push({ path, message: "missing required property" });
      return;
    case "UnexpectedKey":
      out.push({ path, message: "unexpected property" });
      return;
    case "OneOf":
      out.push({ path, message: "matches more than one allowed shape" });
      return;
    case "InvalidValue":
      out.push({ path, message: vettedInputIssueMessages.get(issue) ?? "invalid value" });
      return;
    case "Forbidden":
      out.push({ path, message: "invalid value" });
      return;
  }
}

function formatInputPath(path: ReadonlyArray<PropertyKey>): string {
  return path
    .map((key, index) => {
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
 * and expected shapes, bounded in count and length. Paths may contain property names the agent
 * submitted (capped at 64 characters), but never submitted values. Returns undefined for
 * non-schema errors.
 */
export function describeIntegrationToolInputIssues(error: unknown): string | undefined {
  if (!Schema.isSchemaError(error)) return undefined;
  const issues: Array<InputIssue> = [];
  collectInputIssues(error.issue, [], issues);
  if (issues.length === 0) return undefined;
  const lines = issues
    .slice(0, MAX_INPUT_ISSUES)
    .map(({ path, message }) =>
      path.length > 0 ? `${formatInputPath(path)}: ${message}` : message,
    );
  if (issues.length > MAX_INPUT_ISSUES) {
    lines.push(`${issues.length - MAX_INPUT_ISSUES} more issue(s) omitted`);
  }
  const text = lines.join("; ").trim();
  return text.length > MAX_INPUT_ISSUES_TEXT_LENGTH
    ? `${text.slice(0, MAX_INPUT_ISSUES_TEXT_LENGTH - 1)}…`
    : text;
}
