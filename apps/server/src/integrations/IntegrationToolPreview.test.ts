import { describe, expect, it } from "@effect/vitest";

import { describeToolCallForApproval } from "./IntegrationToolPreview.ts";

describe("describeToolCallForApproval", () => {
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
});
