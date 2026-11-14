import { assert, it } from "@effect/vitest";

import { makeSkillInputSampler, type SkillInputApi } from "./skillRecordingInput.ts";

const COMMAND = 1 << 20;
const SHIFT = 1 << 17;
const B = 11;
const PID = 42;

function fakeInput() {
  const state = {
    frontPid: PID as number | null,
    flags: 0,
    buttons: new Set<number>(),
    keys: new Set<number>(),
    focus: { role: "text_area", subrole: null, protected: false } as ReturnType<
      SkillInputApi["focus"]
    >,
    hit: { role: "button", name: "Save", elementKey: null } as ReturnType<SkillInputApi["hitTest"]>,
    keyReads: 0,
  };
  const api: SkillInputApi = {
    frontPid: () => state.frontPid,
    flags: () => state.flags,
    buttonDown: (button) => state.buttons.has(button),
    keyDown: (keyCode) => {
      state.keyReads += 1;
      return state.keys.has(keyCode);
    },
    pointer: () => ({ x: 10, y: 10 }),
    focus: () => state.focus,
    hitTest: () => state.hit,
    close: () => {},
  };
  let clock = 0;
  const sample = makeSkillInputSampler(api, PID, () => clock);
  const tick = () => {
    clock += 10;
    return sample().map(
      (candidate) => `${candidate.step.kind} ${candidate.step.value ?? candidate.step.name}`,
    );
  };
  return { state, tick };
}

it("never reads ordinary keys without Command or Control held", () => {
  const { state, tick } = fakeInput();
  tick();
  state.keys.add(B);
  state.flags = SHIFT;
  assert.deepEqual([tick(), tick()], [[], []]);
  assert.strictEqual(state.keyReads, 0);
});

it("records a shortcut once per press, and again when pressed again", () => {
  const { state, tick } = fakeInput();
  tick();
  state.flags = COMMAND;
  assert.deepEqual(tick(), []);
  state.keys.add(B);
  assert.deepEqual(tick(), ["shortcut Command+B"]);
  assert.deepEqual(tick(), []);
  state.keys.delete(B);
  tick();
  state.keys.add(B);
  assert.deepEqual(tick(), ["shortcut Command+B"]);
});

it("reads no keys while a protected field has focus", () => {
  const { state, tick } = fakeInput();
  state.focus = { role: "text_field", subrole: "AXSecureTextField", protected: true };
  tick();
  state.flags = COMMAND;
  tick();
  state.keys.add(B);
  assert.deepEqual(tick(), []);
  assert.strictEqual(state.keyReads, 0);
});

it("records clicks only while the app stays in front, not the click that activates it", () => {
  const { state, tick } = fakeInput();
  state.frontPid = 7;
  tick();
  state.buttons.add(0);
  state.frontPid = PID;
  assert.deepEqual(tick(), []);
  state.buttons.clear();
  tick();
  state.buttons.add(1);
  state.flags = COMMAND;
  assert.deepEqual(tick(), ["click Command-Right-click"]);
  state.buttons.clear();
  state.flags = 0;
  tick();
  state.hit = null;
  state.buttons.add(0);
  assert.deepEqual(tick(), []);
});
