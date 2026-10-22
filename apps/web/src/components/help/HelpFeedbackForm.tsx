import type { HelpContext, HelpMessage } from "@t3tools/contracts";
import { CopyIcon, DownloadIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { buildHelpReport } from "./helpReport";
import { HELP_ISSUE_TRACKER_URL } from "./helpLinks";

/** Saves the exact report. Kept outside the component: React Compiler skips `finally`. */
function downloadReport(report: string): boolean {
  let url: string | null = null;
  try {
    url = URL.createObjectURL(new Blob([report], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "tritonai-help-report.md";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } catch {
    return false;
  } finally {
    if (url !== null) URL.revokeObjectURL(url);
  }
}

export function HelpFeedbackForm({
  context,
  conversation,
}: {
  readonly context: HelpContext | null;
  readonly conversation: readonly HelpMessage[];
}) {
  const [summary, setSummary] = useState("");
  const [steps, setSteps] = useState("");
  const [expected, setExpected] = useState("");
  const [actual, setActual] = useState("");
  const [includeConversation, setIncludeConversation] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const report = buildHelpReport({
    context,
    summary,
    steps,
    expected,
    actual,
    conversation,
    includeConversation,
  });

  async function copyReport() {
    try {
      await writeTextToClipboard(report, "Help report");
      setStatus("Report copied.");
    } catch {
      setStatus("Could not copy. Select the preview text or download the report.");
    }
  }

  return (
    <section
      id="help-feedback"
      aria-labelledby="help-feedback-heading"
      className="space-y-5 rounded-xl border border-border/70 p-4 sm:p-5"
    >
      <div className="space-y-1">
        <h2 id="help-feedback-heading" className="text-sm font-semibold">
          Prepare feedback
        </h2>
        <p className="text-sm leading-6 text-muted-foreground">
          Nothing is sent until you submit it in the issue tracker.
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          The issue tracker is public. Review the preview and remove anything private before
          sharing.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="help-feedback-summary">Summary</Label>
          <Input
            id="help-feedback-summary"
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            maxLength={4000}
            placeholder="What would you like us to know?"
          />
        </div>
        {[
          { id: "steps", label: "Steps to reproduce", value: steps, set: setSteps, wide: true },
          { id: "expected", label: "Expected", value: expected, set: setExpected, wide: false },
          { id: "actual", label: "Actual", value: actual, set: setActual, wide: false },
        ].map((field) => (
          <div key={field.id} className={field.wide ? "space-y-2 sm:col-span-2" : "space-y-2"}>
            <Label htmlFor={`help-feedback-${field.id}`}>{field.label}</Label>
            <Textarea
              id={`help-feedback-${field.id}`}
              size="sm"
              value={field.value}
              onChange={(event) => field.set(event.target.value)}
              maxLength={4000}
            />
          </div>
        ))}
      </div>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Checkbox
            id="help-feedback-conversation"
            checked={includeConversation}
            onCheckedChange={setIncludeConversation}
          />
          <Label htmlFor="help-feedback-conversation">Include Help conversation</Label>
        </div>
        <p className="ps-6 text-xs leading-5 text-muted-foreground">
          Only this Help conversation can be included. Project conversations, host paths, and raw
          diagnostics are omitted.
        </p>
      </div>
      <div className="space-y-2">
        <h3 id="help-report-preview-label" className="text-xs font-medium">
          Exact report preview
        </h3>
        <pre
          aria-labelledby="help-report-preview-label"
          tabIndex={0}
          className="max-h-72 overflow-auto rounded-lg bg-muted/40 p-4 font-mono text-xs leading-5 whitespace-pre-wrap outline-none wrap-anywhere focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {report}
        </pre>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void copyReport()}>
          <CopyIcon aria-hidden="true" />
          Copy report
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setStatus(
              downloadReport(report)
                ? "Report download prepared."
                : "Could not download. Copy the report or select the preview text.",
            )
          }
        >
          <DownloadIcon aria-hidden="true" />
          Download report
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void ensureLocalApi()
              .shell.openExternal(HELP_ISSUE_TRACKER_URL)
              .catch(() => setStatus("Could not open the issue tracker. Try again."));
          }}
        >
          <ExternalLinkIcon aria-hidden="true" />
          Open issue tracker
        </Button>
        {/* Always mounted so screen readers announce each result. */}
        <p role="status" className="text-xs leading-5 text-muted-foreground">
          {status}
        </p>
      </div>
    </section>
  );
}
