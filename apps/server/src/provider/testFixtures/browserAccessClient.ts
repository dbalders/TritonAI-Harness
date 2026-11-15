// @effect-diagnostics nodeBuiltinImport:off -- Native IPC fixture for browser authorization integration tests.
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";

export const requestBrowserAccess = (
  environment: Readonly<Record<string, string>>,
  params: unknown,
) =>
  Effect.tryPromise(
    () =>
      new Promise<{ payload: string; signature: string }>((resolve, reject) => {
        const socket = NodeNet.createConnection(environment.BROWSER_USE_ACCESS_PIPE_PATH!);
        socket.on("error", reject);
        socket.setTimeout(5000, () => socket.destroy(new Error("Browser fixture timed out")));
        socket.once("connect", () => {
          const body = Buffer.from(
            JSON.stringify({ jsonrpc: "2.0", method: "browser/access", id: 1, params }),
          );
          const header = Buffer.alloc(4);
          if (NodeOS.endianness() === "LE") header.writeUInt32LE(body.length);
          else header.writeUInt32BE(body.length);
          socket.write(header.subarray(0, 2));
          socket.write(Buffer.concat([header.subarray(2), body]));
        });
        let bytes = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => {
          bytes = Buffer.concat([bytes, chunk]);
          if (bytes.length < 4) return;
          const size = NodeOS.endianness() === "LE" ? bytes.readUInt32LE() : bytes.readUInt32BE();
          if (bytes.length !== size + 4) return;
          const result = JSON.parse(bytes.subarray(4).toString("utf8")) as {
            jsonrpc: string;
            id: number;
            result: { payload: string; signature: string };
          };
          const key = NodeCrypto.createPublicKey({
            key: Buffer.from(environment.BROWSER_USE_ACCESS_VERIFYING_IDENTITY!, "base64"),
            type: "spki",
            format: "der",
          });
          const decision = JSON.parse(result.result.payload);
          if (
            result.jsonrpc !== "2.0" ||
            result.id !== 1 ||
            !NodeCrypto.verify(
              null,
              Buffer.from(result.result.payload),
              key,
              Buffer.from(result.result.signature, "base64"),
            ) ||
            decision.domain !== "codex.browserAccess.v1" ||
            JSON.stringify(decision.request) !== JSON.stringify(params)
          ) {
            reject(new Error("Browser access decision failed verification"));
            socket.destroy();
            return;
          }
          resolve(result.result);
          socket.destroy();
        });
        socket.once("end", () => {
          if (bytes.length === 0) reject(new Error("Request refused"));
        });
      }),
  );
