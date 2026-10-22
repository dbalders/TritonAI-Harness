import { describe, expect, it } from "@effect/vitest";
import { taskResultEvidence } from "./botTaskResults.ts";

const execution = {
  status: "completed" as const,
  threadId: "actual-thread",
  messageId: "actual-message",
};
describe("taskResultEvidence", () => {
  it("keeps execution references host-derived and never upgrades model claims to verified evidence", () => {
    const report = taskResultEvidence(
      "Done.\n```bot-result\n" +
        JSON.stringify({
          summary: "Shipped",
          execution: { threadId: "invented" },
          verification: { status: "verified" },
          artifacts: [
            {
              label: "Report",
              uri: "https://example.test/report",
              kind: "artifact",
              provenance: "harness-upload",
              attachmentId: "invented",
            },
          ],
          checks: [
            { label: "Production checked", status: "reported-pass", provenance: "provider" },
          ],
          blockers: ["Device test not run"],
        }) +
        "\n```",
      execution,
    );
    expect(report.execution.threadId).toBe("actual-thread");
    expect(report.verification.status).toBe("unverified");
    expect(report.artifacts[0]?.provenance).toBe("assistant-reported");
    expect(report.artifacts[0]).not.toHaveProperty("attachmentId");
    expect(report.checks[0]?.provenance).toBe("assistant-reported");
    expect(report.blockers).toEqual(["Device test not run"]);
  });
  it("preserves ordinary Markdown sources and rejects unsafe file or credential-bearing URIs", () => {
    const report = taskResultEvidence(
      '[Source](https://example.test/source)\n```bot-result\n{"artifacts":[{"label":"Local","uri":"file:///private/secret"},{"label":"Unsafe","uri":"https://user:pass@example.test/"}]}\n```',
      execution,
    );
    expect(report.artifacts).toEqual([
      {
        label: "Source",
        uri: "https://example.test/source",
        kind: "source",
        provenance: "assistant-reported",
      },
    ]);
    expect(taskResultEvidence("Done\n```bot-result\ninvalid json\n```", execution).summary).toBe(
      "Done",
    );
  });
});
