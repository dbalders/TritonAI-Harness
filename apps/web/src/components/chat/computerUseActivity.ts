import type { WorkLogEntry } from "../../session-logic";

export function computerUseActivity(
  entry: Pick<WorkLogEntry, "itemType" | "toolData">,
): { action: string; session: string | null } | null {
  if (
    entry.itemType !== "mcp_tool_call" ||
    typeof entry.toolData !== "object" ||
    entry.toolData === null
  )
    return null;
  const data = entry.toolData as Record<string, unknown>;
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
  return { action, session };
}
