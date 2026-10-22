import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

// Standalone protocol peer. Opaque Codex process handles map only to children
// captured at spawn; none of these handles is interpreted as an OS process id.
const workspace = process.argv[2];
if (process.argv[3] === "worker") {
  const name = process.argv[4];
  NodeFS.writeFileSync(NodePath.join(workspace, `${name}-start`), "START\n");
  process.on("message", () => {
    NodeFS.writeFileSync(NodePath.join(workspace, `${name}-finish`), "FINISH\n");
    process.exit(0);
  });
  process.send("ready");
} else {
  const children = new Map();
  const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
  const respond = (id, result) => write({ id, result });
  const notify = (method, params) => write({ method, params });
  const nativeThreadId = "stop-process-thread";
  const mode = process.argv[3];
  const nullId = mode.startsWith("null-");
  let listScans = 0;
  let lateRegistered = false;
  let duplicatePublished = false;
  let turnNumber = 0;
  let pendingTermination;
  let terminationAttempts = 0;
  const turn = (id, status) => ({
    id,
    items: [],
    itemsView: "notLoaded",
    status,
    error: null,
    startedAt: 1782622440,
    completedAt: status === "inProgress" ? null : 1782622450,
    durationMs: null,
  });
  const command = (status) => ({
    type: "commandExecution",
    id: "foreground-command",
    command: "wait; write FINISH",
    cwd: workspace,
    processId: nullId && status === "inProgress" ? null : "foreground-handle",
    source: nullId && status === "inProgress" ? "agent" : "unifiedExecStartup",
    status,
    commandActions: [{ type: "unknown", command: "wait; write FINISH" }],
    aggregatedOutput: null,
    exitCode: status === "completed" ? 0 : null,
    durationMs: null,
  });
  const spawnWorker = async (handle, name) => {
    const child = NodeChildProcess.fork(import.meta.filename, [workspace, "worker", name], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const ready = new Promise((resolve) => child.once("message", resolve));
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const owned = { child, exited, running: true };
    children.set(handle, owned);
    child.once("exit", () => {
      owned.running = false;
    });
    await ready;
    return owned;
  };
  const releaseWorker = async (handle) => {
    const owned = children.get(handle);
    if (!owned?.running) return;
    owned.child.send("continue");
    await owned.exited;
  };
  const handle = async ({ id, method, params }) => {
    switch (method) {
      case "initialize":
        respond(id, {
          userAgent: "stop-process-fixture",
          codexHome: workspace,
          platformFamily: "unix",
          platformOs: "macos",
        });
        return;
      case "initialized":
        return;
      case "thread/start":
        respond(id, {
          thread: {
            id: nativeThreadId,
            sessionId: nativeThreadId,
            forkedFromId: null,
            projectId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1782622440,
            updatedAt: 1782622440,
            status: { type: "idle" },
            path: null,
            cwd: workspace,
            cliVersion: "0.156.1",
            source: "vscode",
            threadSource: null,
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
          model: "gpt-5.4",
          modelProvider: "openai",
          serviceTier: null,
          cwd: workspace,
          instructionSources: [],
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandbox: { type: "dangerFullAccess" },
          reasoningEffort: "medium",
        });
        return;
      case "turn/start": {
        const turnId = `turn-${++turnNumber}`;
        respond(id, { turn: turn(turnId, "inProgress") });
        notify("turn/started", { threadId: nativeThreadId, turn: turn(turnId, "inProgress") });
        if (turnNumber === 1) {
          await spawnWorker("unrelated-handle", "unrelated");
          if (nullId) await spawnWorker("other-thread-handle", "other-thread");
          if (mode === "null-late-item") await spawnWorker("late-handle", "late");
          await spawnWorker("foreground-handle", "foreground");
          notify("item/started", {
            threadId: nativeThreadId,
            turnId,
            item: command("inProgress"),
            startedAtMs: 1782622440500,
          });
        } else {
          notify("turn/completed", { threadId: nativeThreadId, turn: turn(turnId, "completed") });
        }
        return;
      }
      case "turn/interrupt":
        if (process.argv[3] !== "missing-ack") respond(id, {});
        // The provider turn finishes before its separately owned command.
        notify("turn/completed", {
          threadId: nativeThreadId,
          turn: turn(params.turnId, "interrupted"),
        });
        return;
      case "thread/backgroundTerminals/terminate":
        if (
          mode === "null-late-item" &&
          params.threadId === nativeThreadId &&
          params.processId === "late-handle" &&
          lateRegistered
        ) {
          const owned = children.get("late-handle");
          owned.child.kill();
          await owned.exited;
          respond(id, { terminated: true });
          return;
        }
        if (params.threadId !== nativeThreadId || params.processId !== "foreground-handle") {
          throw new Error("Attempted to terminate a command outside the stopped lineage");
        }
        if (
          ["retry", "natural-completion", "null-retry"].includes(mode) &&
          ++terminationAttempts <= 2
        ) {
          respond(id, { terminated: false });
          return;
        }
        if (mode === "null-duplicate-provenance") {
          duplicatePublished = true;
          notify("item/started", {
            threadId: nativeThreadId,
            turnId: "turn-1",
            item: command("inProgress"),
            startedAtMs: 1782622450500,
          });
        }
        if (mode === "null-verify-present" || mode === "null-duplicate-provenance") {
          respond(id, { terminated: true });
          return;
        }
        pendingTermination = id;
        if (mode === "null-duplicate-start") {
          notify("item/started", {
            threadId: nativeThreadId,
            turnId: "turn-1",
            item: command("inProgress"),
            startedAtMs: 1782622450500,
          });
        }
        notify("fixture/terminationPending", {});
        return;
      case "thread/backgroundTerminals/list": {
        if (!nullId) {
          respond(id, { data: [{ processId: "foreground-handle" }], nextCursor: null });
          return;
        }
        if (params.threadId === "other-native-thread") {
          respond(id, {
            data: [{ itemId: "foreground-command", processId: "other-thread-handle" }],
            nextCursor: null,
          });
          return;
        }
        if (params.threadId !== nativeThreadId) throw new Error("Wrong native thread lookup");
        if (!params.cursor) {
          listScans++;
          if (mode === "null-late-registration" && listScans === 1) {
            respond(id, { data: [], nextCursor: null });
            return;
          }
          respond(id, {
            data: [
              {
                itemId: "unrelated-item",
                processId: "unrelated-handle",
                command: "wait; write FINISH",
              },
            ],
            nextCursor: "owned-page",
          });
          return;
        }
        const data = children.get("foreground-handle")?.running
          ? [{ itemId: "foreground-command", processId: "foreground-handle" }]
          : [];
        if (lateRegistered && children.get("late-handle")?.running)
          data.push({ itemId: "late-command", processId: "late-handle" });
        if (mode === "null-no-match" && data.length) data[0].itemId = "another-item";
        if (mode === "null-duplicate-start" && pendingTermination !== undefined && data.length)
          delete data[0].itemId;
        if (mode === "null-duplicate-provenance" && duplicatePublished && data.length)
          delete data[0].itemId;
        if (mode === "null-missing-attribution" && data.length) delete data[0].itemId;
        if (mode === "null-ambiguous" && data.length)
          data.push({ itemId: "foreground-command", processId: "unrelated-handle" });
        respond(id, { data, nextCursor: null });
        return;
      }
      case "fixture/allowTermination": {
        const owned = children.get("foreground-handle");
        if (owned.running) {
          owned.child.kill();
          await owned.exited;
        }
        if (mode === "null-late-item") {
          lateRegistered = true;
          notify("item/started", {
            threadId: nativeThreadId,
            turnId: "turn-1",
            item: { ...command("inProgress"), id: "late-command" },
            startedAtMs: 1782622450500,
          });
        }
        respond(pendingTermination, { terminated: true });
        respond(id, {});
        return;
      }
      case "fixture/releaseForeground":
        await releaseWorker("foreground-handle");
        if (mode === "null-late-item") await releaseWorker("late-handle");
        respond(id, {});
        return;
      case "fixture/completeForeground":
        await releaseWorker("foreground-handle");
        notify("item/completed", {
          threadId: nativeThreadId,
          turnId: "turn-1",
          item: command("completed"),
          completedAtMs: 1782622465500,
        });
        notify("turn/completed", { threadId: nativeThreadId, turn: turn("turn-1", "completed") });
        respond(id, {});
        return;
      case "fixture/releaseUnrelated":
        await releaseWorker("unrelated-handle");
        if (nullId) await releaseWorker("other-thread-handle");
        respond(id, {});
        return;
      case "fixture/eventFence":
        notify("thread/goal/updated", {
          threadId: nativeThreadId,
          goal: {
            threadId: nativeThreadId,
            objective: "event fence",
            status: "paused",
            createdAt: 1782622440,
            updatedAt: 1782622450,
            tokensUsed: 0,
            timeUsedSeconds: 0,
          },
        });
        respond(id, {});
        return;
      case "fixture/normalCompletion":
        // Native completion can race a Stop even while this owned process is
        // still waiting for its separately controlled release/termination.
        notify("turn/completed", { threadId: nativeThreadId, turn: turn("turn-1", "completed") });
        respond(id, {});
        return;
      case "fixture/lateCompletion":
        notify("item/completed", {
          threadId: nativeThreadId,
          turnId: "turn-1",
          item: command("completed"),
          completedAtMs: 1782622465500,
        });
        notify("turn/completed", { threadId: nativeThreadId, turn: turn("turn-1", "completed") });
        respond(id, {});
        return;
      default:
        throw new Error(`Unexpected fixture method: ${method}`);
    }
  };
  NodeReadline.createInterface({ input: process.stdin })
    .on("line", (line) => {
      void handle(JSON.parse(line)).catch((error) => {
        process.stderr.write(`${error.stack}\n`);
        process.exitCode = 1;
      });
    })
    .on("close", async () => {
      for (const { child, running, exited } of children.values()) {
        if (running) child.kill();
        await exited;
      }
    });
  process.once("exit", () => {
    for (const { child, running } of children.values()) if (running) child.kill();
  });
}
