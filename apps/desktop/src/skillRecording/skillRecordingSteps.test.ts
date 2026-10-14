import { assert, it } from "@effect/vitest";

import {
  makeSkillRecordingBuffer,
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

it("stops collecting at the step and time limits and says which one", () => {
  const steps = makeSkillRecordingBuffer({ maxSteps: 2, maxDurationMs: 1_000 });
  for (const name of ["A", "B", "C"]) steps.add(event("focusChanged", { name }), 1);
  assert.strictEqual(steps.finish().steps.length, 2);
  assert.strictEqual(steps.finish().limitReached, "steps");

  const time = makeSkillRecordingBuffer({ maxSteps: 10, maxDurationMs: 1_000 });
  time.add(event("focusChanged", { name: "A" }), 500);
  time.add(event("focusChanged", { name: "B" }), 1_001);
  time.add(event("focusChanged", { name: "C" }), 900);
  assert.deepEqual(time.finish(), {
    steps: [{ atMs: 500, kind: "focus", role: "button", name: "A", value: null }],
    limitReached: "time",
  });
});

it("clips long on-screen text", () => {
  const buffer = makeSkillRecordingBuffer();
  buffer.add(event("focusChanged", { name: "x".repeat(500) }), 0);
  assert.strictEqual(buffer.finish().steps[0]?.name?.length, 160);
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

it("keeps repeated clicks and every focus change", () => {
  const buffer = makeSkillRecordingBuffer();
  const click = { kind: "click", role: "button", name: "Next", value: null } as const;
  buffer.add(event("focusChanged", { role: "button", name: "Next" }), 100);
  buffer.addInput(click, 120);
  buffer.addInput(click, 900);
  buffer.add(event("focusChanged", { role: "button", name: "Back" }), 950);
  buffer.addInput({ kind: "shortcut", role: "button", name: null, value: "Command+B" }, 990);
  buffer.addInput({ kind: "shortcut", role: "button", name: null, value: "Command+I" }, 995);
  assert.deepEqual(
    buffer.finish().steps.map((step) => `${step.kind} ${step.name ?? step.value}`),
    [
      "focus Next",
      "click Next",
      "click Next",
      "focus Back",
      "shortcut Command+B",
      "shortcut Command+I",
    ],
  );
});

it("never keeps text from a combo box's text field", () => {
  const buffer = makeSkillRecordingBuffer();
  buffer.add(
    event("valueChanged", { role: "combo_box", name: "Account", value: "private typed account" }),
    10,
  );
  assert.deepEqual(
    buffer.finish().steps.map((step) => step.value),
    [null],
  );
});

it("keeps mouse-set changes without focus but not text boxes the app updates", () => {
  const buffer = makeSkillRecordingBuffer();
  buffer.add(
    event("valueChanged", { role: "slider", name: "Volume", value: "75", focused: false }),
    100,
  );
  buffer.add(
    event("valueChanged", { role: "combo_box", name: "font size", value: "12", focused: false }),
    200,
  );
  assert.deepEqual(
    buffer.finish().steps.map((step) => `${step.kind} ${step.name} ${step.value}`),
    ["edit Volume 75"],
  );
});

it("drops a text control's label when it repeats the typed text", () => {
  const buffer = makeSkillRecordingBuffer();
  buffer.add(
    event("valueChanged", {
      role: "combo_box",
      name: "private typed account",
      value: "private typed account",
      focused: true,
    }),
    10,
  );
  assert.deepEqual(
    buffer.finish().steps.map((step) => [step.name, step.value]),
    [[null, null]],
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

it("keeps focus moving between unnamed fields after a click", () => {
  const buffer = makeSkillRecordingBuffer();
  buffer.addInput({ kind: "click", role: "text_field", name: null, value: null }, 100);
  buffer.add(event("focusChanged", { role: "text_field", name: null, stableId: "b" }), 200);
  assert.deepEqual(
    buffer.finish().steps.map((step) => step.kind),
    ["click", "focus"],
  );
});

it("reports a full buffer so capture can stop", () => {
  const buffer = makeSkillRecordingBuffer({ maxSteps: 1, maxDurationMs: 60_000 });
  assert.strictEqual(buffer.isFull(), false);
  buffer.addInput({ kind: "shortcut", role: null, name: null, value: "Command+B" }, 10);
  assert.strictEqual(buffer.isFull(), true);
  buffer.addInput({ kind: "shortcut", role: null, name: null, value: "Command+I" }, 20);
  assert.strictEqual(buffer.finish().steps.length, 1);
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

it("keeps focus moving back and forth between look-alike fields", () => {
  const buffer = makeSkillRecordingBuffer();
  for (const [index, stableId] of ["a", "b", "a"].entries()) {
    buffer.add(event("focusChanged", { role: "text_field", name: null, stableId }), index * 10);
  }
  assert.strictEqual(buffer.finish().steps.length, 3);
});

it("records moving between apps, and focus again on return", () => {
  const buffer = makeSkillRecordingBuffer();
  buffer.addApp("Excel", 0);
  buffer.add(event("focusChanged", { role: "cell", name: "B2", stableId: "b2" }), 10);
  buffer.addApp("Safari", 20);
  buffer.addApp("Excel", 30);
  buffer.add(event("focusChanged", { role: "cell", name: "B2", stableId: "b2" }), 40);
  assert.deepEqual(
    buffer.finish().steps.map((step) => `${step.kind} ${step.name}`),
    ["app Excel", "focus B2", "app Safari", "app Excel", "focus B2"],
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
