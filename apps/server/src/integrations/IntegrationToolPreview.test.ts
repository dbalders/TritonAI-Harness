import { describe, expect, it } from "@effect/vitest";

import { describeToolCallForApproval } from "./IntegrationToolPreview.ts";

describe("describeToolCallForApproval", () => {
  it("lists the call's actual arguments under the tool name", () => {
    expect(
      describeToolCallForApproval("microsoft365.chat.message.send", {
        chatId: "19:abc",
        content: "Lunch\n  at noon?",
        importance: null,
        mentions: [{ id: "u1" }],
        urgent: false,
      }),
    ).toBe(
      [
        "microsoft365.chat.message.send",
        'chatId: "19:abc"',
        'content: "Lunch at noon?"',
        "importance: null",
        'mentions: [{"id":"u1"}]',
        "urgent: false",
      ].join("\n"),
    );
  });

  it("bounds long values and long argument lists, and hides secret-looking arguments", () => {
    const detail = describeToolCallForApproval("tool", {
      body: "x".repeat(500),
      apiKey: "sk-live-123",
      ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`field${index}`, index])),
    });
    const lines = detail.split("\n");
    expect(lines[1]).toBe(`body: "${"x".repeat(120)}"… (500 characters)`);
    expect(lines[2]).toBe("apiKey: [hidden]");
    expect(lines).toHaveLength(10);
    expect(lines.at(-1)).toBe("+4 more");
    expect(detail).not.toContain("sk-live");
  });

  it("shows a validated change summary alone, and falls back to the name when nothing is readable", () => {
    expect(
      describeToolCallForApproval("jira_changes_apply", {
        planId: "plan",
        previewHash: "hash",
        summary: 'Comment on ITS-1:\n"Replaced the toner."',
      }),
    ).toBe('jira_changes_apply\nComment on ITS-1: "Replaced the toner."');
    expect(describeToolCallForApproval("tool", { summary: "   ", empty: "" })).toBe("tool");
    expect(describeToolCallForApproval("tool", undefined)).toBe("tool");
  });
});
