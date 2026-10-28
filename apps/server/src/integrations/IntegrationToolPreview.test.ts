// @effect-diagnostics globalDate:off -- Date objects are intentional non-JSON rejection cases.
import { describe, expect, it } from "@effect/vitest";
import { describeToolCallForApproval } from "./IntegrationToolPreview.ts";
import * as Effect from "effect/Effect";
import { makeLiveStreamBudget } from "../orchestration-v2/LiveStreamBudget.ts";
import { snapshotIntegrationInput } from "./IntegrationWriteApproval.ts";

describe("plugin payload review", () => {
  it("keeps credential references, file maps and credential-like text complete", () => {
    const input = {
      files: {
        "tokenizer.py": "print('first')\n# dangerous tail",
        "token.ts": "export const value = 'complete';",
        "credentials.json": '{"reference":"existing-connection"}',
      },
      credentials: { jiraApi: { id: "connection-id", name: "Reviewed account" } },
      secretNotes: ["review this text", { authorization_notes: "also visible" }],
      maxTokens: 200,
    };
    const prompt = describeToolCallForApproval("fixture.write", input);
    expect(JSON.parse(prompt.slice(prompt.indexOf("\n") + 1))).toEqual(input);
  });

  it("refuses raw credential fields instead of approving hidden values", () => {
    for (const key of [
      "apiKey",
      "api_token",
      "password",
      "clientSecret",
      "authorization",
      "githubToken",
      "personalAccessToken",
      "botToken",
      "webhookSecret",
      "dbPassword",
      "oauth_token",
      "x-api-key",
    ]) {
      expect(() =>
        describeToolCallForApproval("fixture.write", { nested: [{ [key]: "synthetic-only" }] }),
      ).toThrow(/credential/iu);
    }
  });

  it("does not bypass complete-review size limits with credential-like field names", () => {
    expect(() =>
      describeToolCallForApproval("fixture.write", {
        files: { "token.ts": "x".repeat(600_000) },
      }),
    ).toThrow(/too large/iu);
  });

  it("retains long code, nested files and the tail even when a summary is supplied", () => {
    const code = `${"first line\n".repeat(400)}dangerous tail`;
    const detail = describeToolCallForApproval("n8n.update", {
      summary: "Only a small change",
      files: [{ name: "workflow.ts", code }],
      ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`field${index}`, index])),
    });
    const payload = JSON.parse(detail.slice(detail.indexOf("\n") + 1));
    expect(payload.files[0].code).toBe(code);
    expect(payload.summary).toBe("Only a small change");
    expect(payload.field11).toBe(11);
  });

  it("rejects credentials before presentation without changing the bytes used for binding", () => {
    const input = { destination: "test", nested: [{ apiKey: "synthetic-one", code: "complete" }] };
    expect(() => describeToolCallForApproval("tool", input)).toThrow(/credential/iu);
    expect(snapshotIntegrationInput(input).digest).not.toBe(
      snapshotIntegrationInput({
        ...input,
        nested: [{ apiKey: "synthetic-two", code: "complete" }],
      }).digest,
    );
  });

  it("detaches and freezes a canonical snapshot before the caller can change it", () => {
    const input = { b: [1, { target: "one" }], a: "body\nlast line" };
    const snapshot = snapshotIntegrationInput(input);
    input.b[1] = { target: "two" };
    expect(snapshot.canonical).toBe('{"a":"body\\nlast line","b":[1,{"target":"one"}]}');
    expect(Object.isFrozen(snapshot.value)).toBe(true);
    expect(snapshot.digest).toBe(
      snapshotIntegrationInput({ a: "body\nlast line", b: [1, { target: "one" }] }).digest,
    );
    expect(snapshot.digest).not.toBe(snapshotIntegrationInput(input).digest);
  });

  it("rejects unsupported values and accessors without executing them", () => {
    let getterCalls = 0;
    const getter = {
      get value() {
        getterCalls += 1;
        return "hidden";
      },
    };
    const sparse = [1];
    sparse.length = 2;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const input of [
      getter,
      cyclic,
      { value: undefined },
      { value: NaN },
      { value: Infinity },
      { value: 1n },
      new Date(0),
      new Proxy({}, {}),
      sparse,
    ])
      expect(() => snapshotIntegrationInput(input)).toThrow();
    expect(getterCalls).toBe(0);
  });

  it("rejects an oversized or deeply nested call instead of presenting a shortened payload", () => {
    expect(() =>
      describeToolCallForApproval("tool", { code: "x".repeat(4 * 1024 * 1024) }),
    ).toThrow();
    let input: unknown = "tail";
    for (let index = 0; index < 65; index += 1) input = { child: input };
    expect(() => snapshotIntegrationInput(input)).toThrow();
    expect(describeToolCallForApproval("tool", undefined)).toBe("tool");
  });
});

it.effect("delivers a deeply nested complete review within the real live-event budget", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let input: unknown = [...Array.from({ length: 89_999 }, () => 0), "LAST REVIEWABLE ELEMENT"];
      for (let depth = 0; depth < 55; depth++) input = { nested: input };
      const prompt = describeToolCallForApproval("fixture.write", input);
      expect(JSON.parse(prompt.slice(prompt.indexOf("\n") + 1))).toEqual(input);
      const budget = yield* makeLiveStreamBudget();
      yield* budget.retain({ event: { type: "approval_request", prompt } });
      expect((yield* budget.usage).retainedItems).toBe(1);
    }),
  ),
);
