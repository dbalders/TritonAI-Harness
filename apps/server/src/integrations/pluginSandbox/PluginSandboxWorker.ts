// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Dedicated Node process adapter owns a real supervisor deadline independent of plugin clocks.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { isRecord, type JsonObject, type JsonValue } from "@t3tools/shared/pluginSdkContract";
import type { IntegrationInvocationContext } from "../IntegrationRegistry.ts";
import { snapshotIntegrationInput } from "../IntegrationWriteApproval.ts";
import { PluginBrokerChannel } from "./PluginBrokerChannel.ts";
import {
  encodePluginBrokerFrame,
  PluginBrokerFrameDecoder,
  PLUGIN_BROKER_PROTOCOL,
} from "./PluginBrokerProtocol.ts";

const WORKER_PROTOCOL = "tritonai.plugin-worker/v1";

interface MacPluginWorkerLaunch {
  readonly platform: NodeJS.Platform;
  readonly supervisor: string;
  readonly runtime: string;
  readonly bootstrap: string;
  readonly policy: string;
  readonly cwd: string;
  readonly cpuSeconds: number;
  readonly wallMs: number;
}

export async function runMacPluginWorker(input: {
  readonly launch: MacPluginWorkerLaunch;
  readonly pluginPath: string;
  readonly configuration: JsonObject;
  readonly toolName: string;
  readonly parameters: JsonObject;
  readonly context: IntegrationInvocationContext;
  readonly authority: Omit<ConstructorParameters<typeof PluginBrokerChannel>[0], "terminate">;
}): Promise<JsonValue> {
  const { launch } = input;
  if (
    launch.platform !== "darwin" ||
    ![
      launch.supervisor,
      launch.runtime,
      launch.bootstrap,
      launch.policy,
      launch.cwd,
      input.pluginPath,
    ].every((path) => NodePath.isAbsolute(path) && !path.includes("\0")) ||
    !Number.isInteger(launch.cpuSeconds) ||
    launch.cpuSeconds < 1 ||
    launch.cpuSeconds > 10 ||
    !Number.isInteger(launch.wallMs) ||
    launch.wallMs < 1 ||
    launch.wallMs > 30_000
  ) {
    return Promise.reject(new Error("Plugin sandbox launch is unavailable."));
  }
  input.context.signal.throwIfAborted();
  const snapshot = snapshotIntegrationInput(input.parameters);
  if (!isRecord(snapshot.value)) throw new Error("Plugin sandbox parameters must be an object.");
  const parameters = snapshot.value as JsonObject;
  const initialize = encodePluginBrokerFrame({
    protocol: WORKER_PROTOCOL,
    kind: "initialize",
    pluginPath: input.pluginPath,
    pluginId: input.authority.binding.pluginId,
    configuration: input.configuration,
  });
  const invoke = encodePluginBrokerFrame({
    protocol: WORKER_PROTOCOL,
    kind: "invoke",
    toolName: input.toolName,
    input: parameters,
  });
  let terminate: (() => void) | undefined;
  const channel = new PluginBrokerChannel({
    ...input.authority,
    terminate: () => terminate?.(),
  });

  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      launch.supervisor,
      [
        launch.runtime,
        launch.bootstrap,
        launch.policy,
        launch.cwd,
        String(launch.cpuSeconds),
        String(launch.wallMs),
      ],
      { stdio: ["pipe", "pipe", "pipe"], env: {} },
    );
    terminate = () => {
      child.stdin.end();
      child.kill("SIGTERM");
    };
    const decoder = new PluginBrokerFrameDecoder();
    let phase: "starting" | "running" | "finishing" | "closed" = "starting";
    let failure: unknown;
    let result: JsonValue | undefined;
    let diagnosticsBytes = 0;
    let frames = 0;
    let operationSettled = false;
    const fail = (cause: unknown) => {
      failure ??= cause;
      channel.revoke();
    };
    const abort = () => fail(new Error("Plugin sandbox invocation was cancelled."));
    const timeout = setTimeout(
      () => fail(new Error("Plugin sandbox supervisor exceeded its deadline.")),
      launch.wallMs + 1_000,
    );
    const send = (frame: Uint8Array) => {
      child.stdin.write(frame, (error) => {
        if (error) fail(error);
      });
    };
    input.context.signal.addEventListener("abort", abort, { once: true });
    if (input.context.signal.aborted) abort();
    child.once("error", fail);
    child.stdin.on("error", fail);
    child.stderr.on("data", (chunk: Uint8Array) => {
      diagnosticsBytes += chunk.byteLength;
      if (diagnosticsBytes > 4_096)
        fail(new Error("Plugin sandbox diagnostics exceeded their limit."));
    });
    child.stdout.on("data", (chunk: Uint8Array) => {
      try {
        for (const message of decoder.push(chunk)) {
          frames++;
          if (frames > 3 || !isRecord(message)) throw new Error("Invalid plugin worker message.");
          if (
            phase === "starting" &&
            message.protocol === WORKER_PROTOCOL &&
            message.kind === "ready" &&
            Object.keys(message).length === 2
          ) {
            channel.beginInvocation(input.toolName, parameters, input.context);
            phase = "running";
            send(invoke);
          } else if (phase === "running" && message.protocol === PLUGIN_BROKER_PROTOCOL) {
            if (typeof message.requestId !== "number")
              throw new Error("Invalid broker request ID.");
            const requestId = message.requestId;
            void channel
              .operation(message)
              .then((value) => {
                operationSettled = true;
                if (phase !== "running") return;
                send(
                  encodePluginBrokerFrame({
                    protocol: PLUGIN_BROKER_PROTOCOL,
                    requestId,
                    kind: "result",
                    value,
                  }),
                );
              })
              .catch(fail);
          } else if (
            phase === "running" &&
            operationSettled &&
            message.protocol === WORKER_PROTOCOL &&
            message.kind === "result" &&
            Object.keys(message).length === 3 &&
            Object.hasOwn(message, "value")
          ) {
            phase = "finishing";
            result = message.value;
          } else throw new Error("Unexpected plugin worker message.");
        }
      } catch (cause) {
        fail(cause);
      }
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      input.context.signal.removeEventListener("abort", abort);
      const finished = phase === "finishing" && result !== undefined && code === 0;
      phase = "closed";
      void (async () => {
        try {
          decoder.end();
          if (failure !== undefined) throw failure;
          if (!finished) throw new Error("Plugin sandbox exited without a complete result.");
          resolve(await channel.completeInvocation(result));
        } catch (cause) {
          reject(new Error("Plugin sandbox invocation failed.", { cause }));
        } finally {
          channel.revoke();
        }
      })();
    });
    if (failure === undefined) send(initialize);
  });
}
