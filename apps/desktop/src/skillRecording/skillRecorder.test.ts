import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import type { SkillRecordingCapture, SkillRecordingStarted } from "./SkillRecordingProcess.ts";
import { makeSkillRecorder, type SkillRecorderDependencies } from "./skillRecorder.ts";

const capture: SkillRecordingCapture = {
  status: "stopped",
  durationMs: 1_200,
  steps: [{ atMs: 0, kind: "focus", role: "button", name: "Submit", value: null }],
  limitReached: null,
};

function harness(options: { permission?: boolean; started?: SkillRecordingStarted } = {}) {
  const started = Promise.withResolvers<SkillRecordingStarted>();
  if (options.started) started.resolve(options.started);
  const process = {
    started: started.promise,
    stop: vi.fn(() => Promise.resolve(capture)),
    cancel: vi.fn(),
  };
  const owners = new Map<number, () => void>();
  const unwatch = vi.fn();
  const shown: Array<string | null> = [];
  const dependencies: SkillRecorderDependencies = {
    hasPermission: () => options.permission ?? true,
    captureInput: false,
    startProcess: vi.fn(() => process),
    watchOwner: (ownerId, onGone) => {
      owners.set(ownerId, onGone);
      return unwatch;
    },
    onActiveChange: (recording) => shown.push(recording?.sessionId ?? null),
  };
  return {
    recorder: makeSkillRecorder(dependencies),
    dependencies,
    process,
    started,
    unwatch,
    shown,
    closeOwner: (ownerId: number) => owners.get(ownerId)?.(),
  };
}

const recording = { status: "recording" } as const;

it("never starts without accessibility access", async () => {
  const { recorder, dependencies } = harness({ permission: false });
  assert.deepEqual(await recorder.start(1, "s1"), { status: "permission-required" });
  assert.strictEqual(vi.mocked(dependencies.startProcess).mock.calls.length, 0);
});

it("returns the capture only to the window that started it, once", async () => {
  const { recorder, process, unwatch } = harness({ started: recording });
  const start = await recorder.start(1, "s1");
  assert.strictEqual(start.status, "recording");

  assert.deepEqual(await recorder.stop("s1", 2), { status: "not-found" });
  assert.deepEqual(await recorder.stop("other", 1), { status: "not-found" });
  assert.deepEqual(await recorder.stop("s1", 1), {
    status: "stopped",
    durationMs: 1_200,
    steps: capture.steps,
    limitReached: null,
  });
  assert.deepEqual(await recorder.stop("s1", 1), { status: "not-found" });
  assert.strictEqual(process.stop.mock.calls.length, 1);
  assert.strictEqual(unwatch.mock.calls.length, 1);
});

it("allows one recording at a time, including while the first is starting", async () => {
  const { recorder, started } = harness();
  const first = recorder.start(1, "s1");
  assert.deepEqual(await recorder.start(1, "s2"), { status: "busy" });
  started.resolve(recording);
  assert.strictEqual((await first).status, "recording");
});

it("discards the recording when its window closes or reloads", async () => {
  const { recorder, process, closeOwner } = harness({ started: recording });
  await recorder.start(1, "s1");
  closeOwner(1);

  assert.strictEqual(process.cancel.mock.calls.length, 1);
  assert.deepEqual(await recorder.stop("s1", 1), { status: "not-found" });
  assert.strictEqual(process.stop.mock.calls.length, 0);
});

it("does not hand out a session whose window closed before it started", async () => {
  const { recorder, started, process, closeOwner } = harness();
  const start = recorder.start(1, "s1");
  closeOwner(1);
  started.resolve(recording);

  assert.deepEqual(await start, { status: "unavailable" });
  assert.strictEqual(process.cancel.mock.calls.length, 1);
});

it("frees the slot when the helper cannot record", async () => {
  const { recorder, process } = harness({ started: { status: "unavailable" } });
  assert.deepEqual(await recorder.start(1, "s1"), { status: "unavailable" });
  assert.strictEqual(process.cancel.mock.calls.length, 1);
  assert.notStrictEqual((await recorder.start(1, "s2")).status, "busy");
});

it("cancel and shutdown discard without reading the capture", async () => {
  const first = harness({ started: recording });
  await first.recorder.start(1, "s1");
  first.recorder.cancel("s1", 2);
  assert.strictEqual(first.process.cancel.mock.calls.length, 0);
  first.recorder.cancel("s1", 1);
  assert.strictEqual(first.process.cancel.mock.calls.length, 1);

  const second = harness({ started: recording });
  await second.recorder.start(1, "s1");
  second.recorder.close();
  assert.strictEqual(second.process.cancel.mock.calls.length, 1);
  assert.strictEqual(second.process.stop.mock.calls.length, 0);
});

it("shows the recording only while it runs, however it ends", async () => {
  const stopped = harness({ started: recording });
  await stopped.recorder.start(1, "s1");
  await stopped.recorder.stop("s1", 1);
  assert.deepEqual(stopped.shown, ["s1", null]);

  const closed = harness({ started: recording });
  await closed.recorder.start(1, "s1");
  closed.closeOwner(1);
  assert.deepEqual(closed.shown, ["s1", null]);

  const failed = harness({ started: { status: "unavailable" } });
  await failed.recorder.start(1, "s1");
  assert.deepEqual(failed.shown, []);
});

it("stops capture from the bar at once and hands the result only to its window", async () => {
  const { recorder, process, shown } = harness({ started: recording });
  await recorder.start(1, "s1");
  recorder.halt("s1");
  assert.strictEqual(process.stop.mock.calls.length, 1);
  assert.deepEqual(shown, ["s1", null]);
  assert.deepEqual(await recorder.stop("s1", 2), { status: "not-found" });
  assert.strictEqual((await recorder.stop("s1", 1)).status, "stopped");
  assert.deepEqual(await recorder.stop("s1", 1), { status: "not-found" });

  const gone = harness({ started: recording });
  await gone.recorder.start(1, "s1");
  gone.recorder.halt("s1");
  gone.closeOwner(1);
  assert.deepEqual(await gone.recorder.stop("s1", 1), { status: "not-found" });
});

it("discards a recording halted from the bar", async () => {
  const { recorder } = harness({ started: recording });
  await recorder.start(1, "s1");
  recorder.halt("s1");
  recorder.cancel("s1", 1);
  assert.deepEqual(await recorder.stop("s1", 1), { status: "not-found" });
});

it("keeps each halted recording for its own window", async () => {
  const { recorder } = harness({ started: recording });
  await recorder.start(1, "s1");
  recorder.halt("s1");
  await recorder.start(2, "s2");
  recorder.halt("s2");
  assert.strictEqual((await recorder.stop("s1", 1)).status, "stopped");
  assert.strictEqual((await recorder.stop("s2", 2)).status, "stopped");
});
