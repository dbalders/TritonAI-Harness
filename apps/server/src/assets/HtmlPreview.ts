import { HTML_RENDER_MAX_PAGE_BYTES } from "@t3tools/shared/htmlRender";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  resolveServerWorkerCommand,
  type ServerWorkerCommand,
} from "../utils/serverWorkerCommand.ts";

export const HTML_PREVIEW_MAX_INPUT_BYTES = HTML_RENDER_MAX_PAGE_BYTES + 128 * 1024;
const MAX_OUTPUT_BYTES = HTML_PREVIEW_MAX_INPUT_BYTES * 2;
const HEAP_MB = 256;
const Headers = Schema.Record(Schema.String, Schema.String);
const decodeHeaders = Schema.decodeEffect(Schema.fromJsonString(Headers));

export class HtmlPreviewError extends Schema.TaggedError<HtmlPreviewError>()("HtmlPreviewError", {
  reason: Schema.String,
}) {}

export class HtmlPreview extends Context.Service<
  HtmlPreview,
  {
    readonly render: (
      html: string,
    ) => Effect.Effect<
      { readonly html: string; readonly headers: typeof Headers.Type },
      HtmlPreviewError
    >;
  }
>()("t3/assets/HtmlPreview") {}

const make = Effect.fn("HtmlPreview.make")(function* (command: ServerWorkerCommand | null) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const slots = yield* Semaphore.make(2);
  let admitted = 0;
  const render = Effect.fn("HtmlPreview.render")((html: string) =>
    Effect.suspend(() => {
      if (!command)
        return Effect.fail(new HtmlPreviewError({ reason: "Preview worker unavailable" }));
      if (Buffer.byteLength(html) > HTML_PREVIEW_MAX_INPUT_BYTES) {
        return Effect.fail(new HtmlPreviewError({ reason: "HTML is too large to preview" }));
      }
      if (admitted >= 4)
        return Effect.fail(new HtmlPreviewError({ reason: "Preview worker busy" }));
      admitted += 1;
      return Effect.gen(function* () {
        const flags = [
          `--max-old-space-size=${HEAP_MB}`,
          "--disallow-code-generation-from-strings",
        ];
        const environment: Record<string, string> = {};
        for (const name of ["ELECTRON_RUN_AS_NODE", "SystemRoot", "SYSTEMROOT", "windir"]) {
          const value = process.env[name];
          if (value !== undefined) environment[name] = value;
        }
        const viaEnvironment = command.limitsVia === "environment";
        if (viaEnvironment) environment.NODE_OPTIONS = flags.join(" ");
        const child = yield* spawner.spawn(
          ChildProcess.make(
            command.command,
            [...(viaEnvironment ? [] : flags), ...command.args, String(HEAP_MB)],
            {
              env: environment,
              extendEnv: false,
              stdin: { stream: Stream.make(Buffer.from(html)) },
              stderr: "ignore",
              killSignal: "SIGKILL",
            },
          ),
        );
        const chunks: Array<Uint8Array> = [];
        let size = 0;
        const [, code] = yield* Effect.all(
          [
            child.stdout.pipe(
              Stream.runForEach((chunk) => {
                size += chunk.byteLength;
                if (size > MAX_OUTPUT_BYTES)
                  return Effect.fail(
                    new HtmlPreviewError({ reason: "Preview output exceeded its limit" }),
                  );
                chunks.push(chunk);
                return Effect.void;
              }),
            ),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (code !== 0)
          return yield* new HtmlPreviewError({
            reason: "Preview exceeded its processing limits",
          });
        const output = Buffer.concat(chunks);
        const headerEnd = output.indexOf(10);
        if (headerEnd < 0 || headerEnd > 4096)
          return yield* new HtmlPreviewError({ reason: "Invalid preview worker response" });
        const headers = yield* decodeHeaders(output.subarray(0, headerEnd).toString("utf8"));
        return { html: output.subarray(headerEnd + 1).toString("utf8"), headers };
      }).pipe(
        Effect.scoped,
        slots.withPermit,
        Effect.timeout("15 seconds"),
        Effect.mapError(
          () => new HtmlPreviewError({ reason: "Preview could not be processed safely" }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            admitted -= 1;
          }),
        ),
      );
    }),
  );
  return HtmlPreview.of({ render });
});

export const layerWithCommand = (command: ServerWorkerCommand | null) =>
  Layer.effect(HtmlPreview, make(command));
export const layer = Layer.unwrap(
  Effect.sync(() => layerWithCommand(resolveServerWorkerCommand("__html-preview"))),
);
