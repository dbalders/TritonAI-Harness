import { assert, it } from "@effect/vitest";

import { HOST_MCP_TOOL_NAMES } from "./hostToolNames.ts";
import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import { DeviceScreenshotToolkit, DeviceStandardToolkit } from "./toolkits/device/tools.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import { HtmlPreviewToolkit, HtmlRenderToolkit } from "./toolkits/html/tools.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";
import { TRITONAI_COMMONS_SUBMIT_TOOL_NAME } from "./TritonAiCommonsTool.ts";

// Keep in step with the toolkits McpHttpServer.makeLayer registers and reserves.
// regression: #400 fix(integrations): restore plugin access, failure detail, and approvals after orchestration-v2
it("lists exactly the tools the Harness MCP server registers itself", () => {
  const registered = [
    ...[
      PreviewToolkit,
      OrchestratorToolkit,
      ThreadToolkit,
      AttachmentToolkit,
      ProjectToolkit,
      EnvironmentToolkit,
      PreviewControlsToolkit,
      WorktreeToolkit,
      PullRequestsToolkit,
      DeviceStandardToolkit,
      DeviceScreenshotToolkit,
      HtmlPreviewToolkit,
      HtmlRenderToolkit,
    ].flatMap((toolkit) => Object.keys(toolkit.tools)),
    TRITONAI_COMMONS_SUBMIT_TOOL_NAME,
  ];
  assert.deepEqual([...HOST_MCP_TOOL_NAMES].sort(), [...new Set(registered)].sort());
});
