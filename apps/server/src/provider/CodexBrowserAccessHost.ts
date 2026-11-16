// @effect-diagnostics nodeBuiltinImport:off -- Private native browser authorization transport owned by the Codex adapter.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FiberSet from "effect/FiberSet";
import * as Schema from "effect/Schema";
import { acquirePrivateIpcEndpoint } from "./privateIpcEndpoint.ts";

const MAX_FRAME_BYTES = 2048;
const MAX_CONNECTIONS = 32;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const Request = Schema.Struct({
  executorId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  sessionId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  turnId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  nonce: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
const RpcRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  method: Schema.Literal("browser/access"),
  params: Request,
  id: Schema.Int,
});
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(RpcRequest), {
  onExcessProperty: "error",
});

class BrowserAccessHostError extends Schema.TaggedError<BrowserAccessHostError>()(
  "BrowserAccessHostError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not start the private browser authorization host.";
  }
}

const io = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (cause) => new BrowserAccessHostError({ cause }) });

// OpenAI's native pipe protocol prefixes JSON with a native-endian uint32 length.
const frame = (value: unknown) => {
  const payload = Buffer.from(encodeJson(value));
  const header = Buffer.alloc(4);
  if (NodeOS.endianness() === "LE") header.writeUInt32LE(payload.length);
  else header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
};
const readFrame = (socket: NodeNet.Socket) =>
  Effect.callback<string, BrowserAccessHostError>((resume) => {
    let bytes = Buffer.alloc(0);
    const fail = () =>
      resume(Effect.fail(new BrowserAccessHostError({ cause: "Invalid browser access frame" })));
    const onData = (chunk: Buffer) => {
      if (bytes.length + chunk.length > MAX_FRAME_BYTES + 4) return fail();
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 4) return;
      const size = NodeOS.endianness() === "LE" ? bytes.readUInt32LE() : bytes.readUInt32BE();
      if (size > MAX_FRAME_BYTES || bytes.length > size + 4) return fail();
      if (bytes.length === size + 4) resume(Effect.succeed(bytes.subarray(4).toString("utf8")));
    };
    socket.on("data", onData);
    socket.once("error", fail);
    socket.once("close", fail);
    socket.once("end", fail);
    return Effect.sync(() => {
      socket.off("data", onData);
      socket.off("error", fail);
      socket.off("close", fail);
      socket.off("end", fail);
    });
  }).pipe(Effect.timeout("5 seconds"));

export const deniedBrowserAccessEnvironment: Readonly<Record<string, string>> = {
  BROWSER_USE_ACCESS_EXECUTOR_ID: "",
  BROWSER_USE_ACCESS_PIPE_PATH: "",
  BROWSER_USE_ACCESS_VERIFYING_IDENTITY: "",
};

export const makeCodexBrowserAccessHost = Effect.fn("CodexBrowserAccessHost.open")(function* (
  isAllowed: (request: {
    readonly sessionId: string;
    readonly turnId: string;
  }) => Effect.Effect<boolean>,
) {
  const platform = yield* HostProcess.Platform;
  const endpoint = yield* acquirePrivateIpcEndpoint("t3-browser").pipe(
    Effect.mapError((cause) => new BrowserAccessHostError({ cause })),
  );
  const { publicKey, privateKey } = yield* Effect.try({
    try: () => NodeCrypto.generateKeyPairSync("ed25519"),
    catch: (cause) => new BrowserAccessHostError({ cause }),
  });
  const executorId = NodeCrypto.randomUUID();
  const fibers = yield* FiberSet.make<void>();
  const run = yield* FiberSet.runtime(fibers)();
  const sockets = new Set<NodeNet.Socket>();
  let closing = false;
  const server = NodeNet.createServer((socket) => {
    socket.on("error", () => {});
    if (closing || sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    run(
      Effect.gen(function* () {
        const request = yield* readFrame(socket).pipe(Effect.flatMap(decode));
        const allowed =
          request.params.executorId === executorId &&
          !closing &&
          (yield* isAllowed(request.params).pipe(
            Effect.timeout("5 seconds"),
            Effect.orElseSucceed(() => false),
          ));
        const payload = encodeJson({
          domain: "codex.browserAccess.v1",
          request: request.params,
          allowed,
        });
        const signature = NodeCrypto.sign(null, Buffer.from(payload), privateKey).toString(
          "base64",
        );
        yield* Effect.callback<void>((resume) => {
          socket.end(
            frame({ jsonrpc: "2.0", id: request.id, result: { payload, signature } }),
            () => resume(Effect.void),
          );
        }).pipe(Effect.timeout("5 seconds"));
      }).pipe(Effect.ignoreCause, Effect.ensuring(Effect.sync(() => socket.destroy()))),
    );
  });
  server.on("error", () => {});
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closing = true;
      for (const socket of sockets) socket.destroy();
      yield* Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())));
      yield* FiberSet.clear(fibers);
    }),
  );
  yield* Effect.callback<void, BrowserAccessHostError>((resume) => {
    const onError = (cause: Error) => resume(Effect.fail(new BrowserAccessHostError({ cause })));
    server.once("error", onError);
    try {
      server.listen(endpoint, () => resume(Effect.void));
    } catch (cause) {
      resume(Effect.fail(new BrowserAccessHostError({ cause })));
    }
    return Effect.sync(() => server.off("error", onError));
  });
  if (platform !== "win32") yield* io(() => NodeFSP.chmod(endpoint, 0o600));
  return {
    BROWSER_USE_ACCESS_EXECUTOR_ID: executorId,
    BROWSER_USE_ACCESS_PIPE_PATH: endpoint,
    BROWSER_USE_ACCESS_VERIFYING_IDENTITY: publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64"),
  };
});
