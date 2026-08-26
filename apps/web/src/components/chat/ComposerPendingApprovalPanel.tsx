import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { cn } from "~/lib/utils";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  className?: string;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  className,
}: ComposerPendingApprovalPanelProps) {
  const fallbackLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access approval"
      : approval.requestKind === "command"
        ? "Command approval"
        : approval.requestKind === "file-read"
          ? "File read approval"
          : "File change approval";
  const detailAriaLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access request"
      : approval.requestKind === "command"
        ? "Command"
        : approval.requestKind === "file-read"
          ? "File to read"
          : "File change";

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">PENDING APPROVAL</span>
        <span className="text-sm font-medium">{approvalSummary}</span>
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
      </div>
      {approval.detail ? (
        <div className="mt-3 rounded-lg border border-border/65 bg-background/70 p-3">
          <p className="text-xs font-medium text-muted-foreground">{detailLabel}</p>
          <pre
            aria-label={detailLabel}
            className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground"
            data-approval-detail="complete"
            tabIndex={0}
          >
            {approval.detail}
          </pre>
        </div>
      ) : null}
    </div>
  );
});
