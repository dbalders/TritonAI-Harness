import type { WorkLogEntry } from "../../session-logic";

export function computerUseActivity(
  entry: Pick<WorkLogEntry, "itemType" | "toolData" | "structuredPayload">,
): { action: string; session: string | null; refreshNeeded: boolean } | null {
  const item = entry.structuredPayload;
  const data: Record<string, unknown> | null =
    item?.type === "dynamic_tool" && item.toolName?.startsWith("cua-driver.")
      ? {
          server: "cua-driver",
          tool: item.toolName.slice("cua-driver.".length),
          arguments: item.input,
          result: item.output,
          status: item.status,
        }
      : entry.itemType === "dynamic_tool" &&
          typeof entry.toolData === "object" &&
          entry.toolData !== null
        ? (entry.toolData as Record<string, unknown>)
        : null;
  if (!data) return null;
  if (data.server !== "cua-driver" || typeof data.tool !== "string") return null;
  const tool = data.tool;
  const args =
    typeof data.arguments === "object" && data.arguments !== null
      ? (data.arguments as Record<string, unknown>)
      : {};
  const session =
    typeof args.session_name === "string"
      ? args.session_name
      : typeof args.session === "string"
        ? args.session
        : null;
  const action =
    tool === "start_session"
      ? "Start session"
      : tool === "end_session"
        ? "End session"
        : /screenshot|capture/.test(tool)
          ? "Capture screen"
          : /click/.test(tool)
            ? "Click"
            : /type|text/.test(tool)
              ? "Type text"
              : /scroll/.test(tool)
                ? "Scroll"
                : /key|shortcut/.test(tool)
                  ? "Press keys"
                  : /drag/.test(tool)
                    ? "Drag"
                    : /list|inspect|state|accessibility/.test(tool)
                      ? "Inspect desktop"
                      : tool.replaceAll("_", " ");
  const result =
    typeof data.result === "object" && data.result !== null
      ? (data.result as Record<string, unknown>)
      : null;
  const content =
    Array.isArray(data.result) || typeof data.result === "string" ? data.result : result?.content;
  const messages =
    typeof content === "string"
      ? [content]
      : Array.isArray(content)
        ? content.flatMap((block: unknown) => {
            if (typeof block !== "object" || block === null) return [];
            const item = block as Record<string, unknown>;
            return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
          })
        : [];
  // Match the driver's response, never arguments or arbitrary captured page text.
  const refreshNeeded =
    data.status === "failed" &&
    data.error == null &&
    messages.length === 1 &&
    (!Array.isArray(content) || content.length === 1) &&
    messages[0]?.trim() === "element_token is stale; call get_window_state again to refresh";
  return { action, session, refreshNeeded };
}
