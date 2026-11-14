import { assert, it } from "@effect/vitest";

import {
  makeSkillRecordingBuffer,
  snapshotAccessibilityEvent,
  type RecordedAccessibilityEvent,
} from "./skillRecordingSteps.ts";

const event = (
  type: string,
  target: Partial<NonNullable<RecordedAccessibilityEvent["target"]>> = {},
  state: { stateFlag?: string; stateValue?: boolean } = {},
): RecordedAccessibilityEvent => ({
  type,
  stateFlag: state.stateFlag ?? null,
  stateValue: state.stateValue ?? null,
  target: {
    role: "button",
    name: "Save",
    value: null,
    editable: false,
    stableId: null,
    raw: {},
    ...target,
  },
});

it("never keeps text typed into editable or secure fields", () => {
  const buffer = makeSkillRecordingBuffer();
  buffer.add(
    event("valueChanged", {
      role: "text_field",
      name: "Email",
      value: "me@ucsd.edu",
      editable: true,
    }),
    10,
  );
  buffer.add(
    event("valueChanged", {
      role: "text_field",
      name: "Password",
      value: "hunter2",
      editable: false,
      raw: { ax_subrole: "AXSecureTextField" },
    }),
    20,
  );
  // A combo box can hold typed text even when not reported editable.
  buffer.add(
    event("selectionChanged", { role: "combo_box", name: "Term", value: "Fall 2026" }),
    30,
  );
  buffer.add(
    event("selectionChanged", { role: "pop_up_button", name: "Fund", value: "General" }),
    40,
  );

  assert.deepEqual(
    buffer.finish().steps.map((step) => [step.name, step.value]),
    [
      ["Email", null],
      ["Password", null],
      ["Term", null],
      ["Fund", "General"],
    ],
  );
});

it("collapses typing in one field into a single step", () => {
  const buffer = makeSkillRecordingBuffer();
  for (const [index, value] of ["h", "he", "hel"].entries()) {
    buffer.add(
      event("valueChanged", { role: "text_field", name: "Notes", value, stableId: "notes" }),
      index * 100,
    );
  }
  buffer.add(
    event("valueChanged", { role: "text_field", name: "Title", value: "x", stableId: "title" }),
    400,
  );

  const { steps } = buffer.finish();
  assert.deepEqual(
    steps.map((step) => [step.kind, step.name, step.atMs]),
    [
      ["edit", "Notes", 0],
      ["edit", "Title", 400],
    ],
  );
});

it("drops noisy and unrelated events and repeated focus", () => {
  const buffer = makeSkillRecordingBuffer();
  // Finder's copy progress updates these while the user does nothing.
  buffer.add(event("valueChanged", { role: "progress_bar", name: null, value: "40" }), 0);
  buffer.add(
    event("valueChanged", { role: "static_text", name: "2 of 9 items", value: "2 of 9 items" }),
    0,
  );
  buffer.add(event("structureChanged"), 1);
  buffer.add(event("stateChanged", {}, { stateFlag: "busy", stateValue: true }), 2);
  buffer.add(event("focusChanged"), 3);
  buffer.add(event("focusChanged"), 4);
  buffer.add(
    event(
      "stateChanged",
      { role: "check_box", name: "Remember" },
      { stateFlag: "checked", stateValue: true },
    ),
    5,
  );

  assert.deepEqual(
    buffer.finish().steps.map((step) => [step.kind, step.value]),
    [
      ["focus", null],
      ["toggle", "checked on"],
    ],
  );
});

it("ignores caret moves while typing and controls the app updates itself", () => {
  const buffer = makeSkillRecordingBuffer();
  const body = { role: "text_area", name: null, editable: true, focused: true, stableId: "body" };
  buffer.add(event("focusChanged", body), 0);
  buffer.add(event("windowOpened", { role: "window", name: null }), 1);
  buffer.add(event("focusChanged", body), 2);
  for (let index = 0; index < 5; index += 1) {
    buffer.add(event("selectionChanged", body), 10 + index);
    buffer.add(event("valueChanged", body), 10 + index);
    // A font menu following the caret, as TextEdit's toolbar does.
    buffer.add(
      event("valueChanged", {
        role: "combo_box",
        name: "typeface",
        value: "Helvetica",
        focused: false,
      }),
      10 + index,
    );
  }
  buffer.add(
    event("valueChanged", { role: "pop_up_button", name: "Style", value: "Bold", focused: true }),
    40,
  );
  assert.deepEqual(
    buffer.finish().steps.map((step) => `${step.kind} ${step.role} ${step.value}`),
    [
      "focus text_area null",
      "window window null",
      "edit text_area null",
      "edit pop_up_button Bold",
    ],
  );
});

it("collapses typing into one step when the label echoes it", () => {
  const buffer = makeSkillRecordingBuffer();
  for (const [atMs, typed] of [
    [10, "a"],
    [20, "ab"],
    [30, "abc"],
  ] as const) {
    buffer.add(
      event("valueChanged", { role: "text_field", name: typed, value: typed, focused: true }),
      atMs,
    );
  }
  assert.deepEqual(
    buffer.finish().steps.map((step) => [step.kind, step.name, step.value]),
    [["edit", null, null]],
  );
});

it("drops a text control's label when it contains the typed text", () => {
  const buffer = makeSkillRecordingBuffer();
  buffer.add(
    event("valueChanged", {
      role: "text_field",
      name: "Search: Private Typed Account",
      value: "private typed account",
      focused: true,
    }),
    10,
  );
  assert.deepEqual(
    buffer.finish().steps.map((step) => step.name),
    [null],
  );
});

it("drops a label that echoes typed text too long to show in full", () => {
  const buffer = makeSkillRecordingBuffer();
  const typed = "private account number ".repeat(8);
  buffer.add(
    event("valueChanged", {
      role: "search_field",
      name: `Search: ${typed}`,
      value: typed,
      editable: true,
      stableId: "search",
    }),
    0,
  );
  const [step] = buffer.finish().steps;
  assert.strictEqual(step?.name, null);
});

it("never reads a password field's label or contents", () => {
  const reads: Array<string> = [];
  const forbidden = (field: string) => {
    reads.push(field);
    return "hunter2";
  };
  const nativeEvent = (role: string, raw: Record<string, unknown>) => ({
    type: "valueChanged",
    stateFlag: null,
    stateValue: null,
    target: {
      role,
      get name(): string | null {
        return forbidden("name");
      },
      get value(): string | null {
        return forbidden("value");
      },
      editable: true,
      focused: true,
      stableId: null,
      raw,
    },
  });

  for (const event of [
    nativeEvent("password_field", {}),
    nativeEvent("text_field", { ax_subrole: "AXSecureTextField", ax_value: "hunter2" }),
  ]) {
    const target = snapshotAccessibilityEvent(event).target;
    assert.strictEqual(target?.name, null);
    assert.strictEqual(target?.value, null);
    assert.notInclude(JSON.stringify(target), "hunter2");
  }
  assert.deepEqual(reads, []);
});
