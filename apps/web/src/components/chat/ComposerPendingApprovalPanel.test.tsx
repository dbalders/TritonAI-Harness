import { ApprovalRequestId, EventId, OrchestrationThreadActivity } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { derivePendingApprovals } from "../../session-logic";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

const decodeProjectedActivity = Schema.decodeUnknownSync(
  Schema.fromJsonString(OrchestrationThreadActivity),
);

describe("ComposerPendingApprovalPanel", () => {
  it("renders complete multiline command details without hover or truncation", () => {
    const detail = `bun run release -- ${"long-argument ".repeat(20)}\nsecond line`;
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-1"),
          requestKind: "command",
          createdAt: "2026-07-18T00:00:00.000Z",
          detail,
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain('data-approval-detail="complete"');
    expect(markup).toContain('aria-label="Command"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain(detail);
    expect(markup).not.toContain("truncate");
    expect(markup).not.toContain("line-clamp");
  });

  it("renders complete details from a projected server approval activity", () => {
    const detail = `bun run release -- ${"long-argument ".repeat(20)}\nsecond line`;
    const projectedActivity = decodeProjectedActivity(
      JSON.stringify({
        id: EventId.make("evt-request-opened"),
        tone: "approval",
        kind: "approval.requested",
        summary: "Command approval requested",
        payload: {
          requestId: "approval-projected-1",
          requestType: "command_execution_approval",
          detail,
        },
        turnId: null,
        createdAt: "2026-07-18T00:00:00.000Z",
      }),
    );
    const [approval] = derivePendingApprovals([projectedActivity]);

    expect(approval).toBeDefined();
    if (!approval) {
      return;
    }

    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel approval={approval} pendingCount={1} />,
    );

    expect(approval.detail).toBe(detail);
    expect(markup).toContain('data-approval-detail="complete"');
    expect(markup).toContain(detail);
  });
});
