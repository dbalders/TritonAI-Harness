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
    processId: "foreground-handle",
    source: "unifiedExecStartup",
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
        if (params.threadId !== nativeThreadId || params.processId !== "foreground-handle") {
          throw new Error("Attempted to terminate a command outside the stopped lineage");
        }
        if (
          ["retry", "natural-completion"].includes(process.argv[3]) &&
          ++terminationAttempts <= 2
        ) {
          respond(id, { terminated: false });
          return;
        }
        pendingTermination = id;
        notify("fixture/terminationPending", {});
        return;
      case "thread/backgroundTerminals/list":
        respond(id, { data: [{ processId: "foreground-handle" }], nextCursor: null });
        return;
      case "fixture/allowTermination": {
        const owned = children.get("foreground-handle");
        if (owned.running) {
          owned.child.kill();
          await owned.exited;
        }
        respond(pendingTermination, { terminated: true });
        respond(id, {});
        return;
      }
      case "fixture/releaseForeground":
        await releaseWorker("foreground-handle");
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
