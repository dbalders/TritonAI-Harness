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
const MAX_QUEUED_PREVIEWS = 64;
const Headers = Schema.Record(Schema.String, Schema.String);
const decodeHeaders = Schema.decodeEffect(Schema.fromJsonString(Headers));

export class HtmlPreviewError extends Schema.TaggedError<HtmlPreviewError>()("HtmlPreviewError", {
  reason: Schema.Literals(["unavailable", "too_large", "busy", "processing"]),
  cause: Schema.optional(Schema.Defect()),
}) {}
const isHtmlPreviewError = Schema.is(HtmlPreviewError);
const processingError = (cause: unknown) =>
  isHtmlPreviewError(cause) ? cause : new HtmlPreviewError({ reason: "processing", cause });

export class HtmlPreview extends Context.Service<
  HtmlPreview,
  {
    readonly render: <E, R>(
      load: Effect.Effect<string, E, R>,
    ) => Effect.Effect<
      { readonly html: string; readonly headers: typeof Headers.Type },
      HtmlPreviewError,
      R
    >;
  }
>()("t3/assets/HtmlPreview") {}

const make = Effect.fn("HtmlPreview.make")(function* (command: ServerWorkerCommand | null) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const slots = yield* Semaphore.make(2);
  let admitted = 0;
  const render = Effect.fn("HtmlPreview.render")(<E, R>(load: Effect.Effect<string, E, R>) =>
    Effect.suspend(() => {
      if (!command) return Effect.fail(new HtmlPreviewError({ reason: "unavailable" }));
      if (admitted >= 2 + MAX_QUEUED_PREVIEWS)
        return Effect.fail(new HtmlPreviewError({ reason: "busy" }));
      admitted += 1;
      return Effect.gen(function* () {
        const html = yield* load.pipe(Effect.mapError(processingError));
        if (Buffer.byteLength(html) > HTML_PREVIEW_MAX_INPUT_BYTES) {
          return yield* new HtmlPreviewError({ reason: "too_large" });
        }
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
        const child = yield* spawner
          .spawn(
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
          )
          .pipe(Effect.mapError(processingError));
        const chunks: Array<Uint8Array> = [];
        let size = 0;
        const [, code] = yield* Effect.all(
          [
            child.stdout.pipe(
              Stream.runForEach((chunk) => {
                size += chunk.byteLength;
                if (size > MAX_OUTPUT_BYTES)
                  return Effect.fail(new HtmlPreviewError({ reason: "processing" }));
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
            reason: "processing",
          });
        const output = Buffer.concat(chunks);
        const headerEnd = output.indexOf(10);
        if (headerEnd < 0 || headerEnd > 4096)
          return yield* new HtmlPreviewError({ reason: "processing" });
        const headers = yield* decodeHeaders(output.subarray(0, headerEnd).toString("utf8")).pipe(
          Effect.mapError(processingError),
        );
        return { html: output.subarray(headerEnd + 1).toString("utf8"), headers };
      }).pipe(
        Effect.scoped,
        slots.withPermit,
        Effect.timeout("15 seconds"),
        Effect.mapError(processingError),
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
