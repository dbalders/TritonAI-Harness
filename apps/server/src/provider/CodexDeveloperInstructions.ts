import { describeComputerUseReadiness, type DesktopComputerUseState } from "@t3tools/contracts";
import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `## TritonAI Harness collaborative browser

You are running inside TritonAI Harness. Its product-native collaborative browser is shared with the user through \`preview_*\` tools. Prefer those tools for browser navigation, page inspection, text extraction, and interaction regardless of whether the runtime transports them directly or through MCP.

For browser work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` before concluding that the browser is unavailable. For background online research call \`preview_open\` with \`show=false\`; use \`show=true\` when the user asks to see or interact with the browser. Then use \`preview_navigate\`, \`preview_snapshot\`, and \`preview_evaluate\` to read the page. Prefer snapshot-provided locators over coordinates and include the source URLs used in the answer. Browser results provide DOM text and semantic page data, not screenshot images.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Use an alternative browser system only when the T3 preview tools are absent, the user explicitly requests another browser, or \`preview_open\` returns an explicit unsupported/unavailable error. A failed T3 preview tool call should be inspected and retried with corrected arguments when the error is actionable.`;
import { T3_CODE_ORCHESTRATION_SECTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
const TRITONAI_COMPUTER_USE_INSTRUCTIONS = `## TritonAI Harness computer use

Users invoke computer use in plain language or with /computer-use; it is a built-in capability, not a $ skill. When the user specifically asks for computer use, prefer the cua-driver tools over browser-only automation or shell scripts.

When the cua-driver MCP tools are available and a task requires native desktop interaction, use them instead of claiming that local app control is unavailable. Start one named session with start_session, pass that same session name to every subsequent tool call, and always finish with end_session. Prefer accessibility elements and window-scoped capture over raw coordinates. Observe before acting, verify the result after each meaningful action, and do not bypass approval or permission failures. If an action returns "element_token is stale; call get_window_state again to refresh", treat it as a normal observation step: call get_window_state for the same window and session, locate the intended control again, and retry with the fresh element token. Never reuse the stale token or guess a replacement. Do not ask the user to fix permissions or report an error for this routine refresh. If fresh observations repeatedly cannot resolve the target, explain the blocker and ask for help only when needed. The visible agent cursor belongs to the named session; do not move the user's physical pointer.

Immediately after start_session, call set_agent_cursor_motion for that session before interacting. Use arc_size=0, turn_radius=1, spring=1, and glide_duration_ms=180 as defaults, substituting any explicitly user-requested motion values in this initial call. These settings keep the visible cursor's travel short and direct with minimal turning and bounce. Configure motion once at session start; call again only if the user later requests a motion change. Avoid decorative cursor moves, loops, and extra waypoints; move directly to the next target. If the driver reports that cursor motion is unsupported, continue the task without retrying the cosmetic configuration.`;

const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = `## TritonAI Harness devices

For iOS Simulators and Android Emulators here, call \`device_list\`, then \`device_open\`. Drive the device with the exact \`agent-device\` launcher and flags it returns, on every command. Prefer \`agent-device snapshot -i\` refs over coordinates. Use \`device_screenshot\` to see the screen. Use \`xcrun simctl\` or \`adb\` only for builds, logs, and ports. If a platform is unavailable, say so.`;

export interface T3CodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | T3CodeToolAvailability,
): T3CodeToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/** Instructions for unavailable tools would steer the model away from its remaining automation. */
const toolInstructions = (availability: boolean | T3CodeToolAvailability): string => {
  const tools = normalizeAvailability(availability);
  return [
    tools.browser ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS : "",
    tools.device ? T3_CODE_DEVICE_TOOL_INSTRUCTIONS : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  toolsAvailable: boolean | T3CodeToolAvailability = true,
  computerUseState?: DesktopComputerUseState,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolInstructions(toolsAvailable);
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    ...Object.fromEntries(
      T3_CODE_ORCHESTRATION_SECTIONS.map((section, index) => [
        `t3_code_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    t3_code_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({ harness: "Codex", ...runtime }),
    },
    ...(tools ? { t3_code_tools: { kind: "application", value: tools } } : {}),
    tritonai_computer_use: { kind: "application", value: TRITONAI_COMPUTER_USE_INSTRUCTIONS },
    computer_use_status: {
      kind: "application",
      value: computerUseStatusInstructions(computerUseState),
    },
  };
}

function computerUseStatusInstructions(
  computerUseState: DesktopComputerUseState | undefined,
): string {
  const computerUseStatus = computerUseState
    ? describeComputerUseReadiness(computerUseState)
    : {
        ready: false,
        label: "Unknown",
        detail:
          "No desktop startup status was reported. This can mean an unsupported environment or a failed desktop status check. Computer use requires the local TritonAI Harness desktop backend and the Codex provider; remote, WSL, and browser-only environments do not receive host desktop access.",
      };
  return `Desktop startup status: ${computerUseStatus.label}. ${computerUseStatus.detail} ${computerUseStatus.ready ? "Refresh stale UI references and continue as described in the computer use instructions. For other failures, report the actual blocker; direct the user to Settings > General > Computer use only for an actual permission or setup problem." : !computerUseState ? "If asked to use computer use, use the desktop tools if they are available. Otherwise explain that readiness is unknown: on the local desktop, ask the user to check Computer use readiness and retry; in remote, WSL, or browser-only environments, explain that host desktop access is unavailable. Do not infer a permission failure or unsupported environment from missing status alone, silently substitute shell/browser automation, or attempt to grant permissions yourself." : "If asked to use computer use, explain this blocker and direct the user to Settings > General > Computer use. Do not claim the app is missing, silently substitute shell/browser automation, or attempt to grant permissions yourself. Permission changes require restarting Harness before this environment reconnects."}`;
}
