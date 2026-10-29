import * as Schema from "effect/Schema";

export const PLUGIN_TOOL_DISCOVERY_NAME = "plugin_tools";

const BrowseInput = Schema.Struct({
  namespace: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64))),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

const decodeInput = Schema.decodeUnknownSync(BrowseInput);

/** Browsing names gives lexical search an exact lookup without loading unrelated schemas. */
export function makePluginToolBrowser(
  tools: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly namespace?: string;
    readonly deferLoading?: boolean;
  }>,
) {
  const deferred = tools
    .filter((tool) => tool.deferLoading === true && tool.namespace !== undefined)
    .toSorted((left, right) => left.name.localeCompare(right.name));
  const namespaces = [...new Set(deferred.map((tool) => tool.namespace!))].toSorted();
  return {
    definition: {
      name: PLUGIN_TOOL_DISCOVERY_NAME,
      description:
        "Browse plugin operation names before loading their schemas. Start here for plugin tasks: " +
        "omit namespace to list services, then provide a returned namespace to browse its operations. " +
        "Choose the operation that matches the task and call tool_search with its exact name and limit 1. " +
        "Follow nextOffset when more entries exist. This lists session-registered definitions; " +
        "execution separately checks connection, permissions, and approval.",
      inputSchema: Schema.toJsonSchemaDocument(BrowseInput, { onExcessProperty: "error" }).schema,
      requiresApproval: false,
    },
    browse: (arguments_: unknown) => {
      const { namespace, offset = 0 } = decodeInput(arguments_, { onExcessProperty: "error" });
      const entries =
        namespace === undefined
          ? namespaces.map((name) => ({ namespace: name }))
          : deferred
              .filter((tool) => tool.namespace === namespace)
              .map((tool) => ({
                namespace,
                name: tool.name,
                description: tool.description.replace(/\s+/gu, " ").slice(0, 120),
              }));
      const page = entries.slice(offset, offset + 32);
      return {
        entries: page,
        total: entries.length,
        nextOffset: offset + page.length < entries.length ? offset + page.length : null,
      };
    },
  };
}
