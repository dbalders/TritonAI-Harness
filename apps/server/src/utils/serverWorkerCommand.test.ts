// @effect-diagnostics nodeBuiltinImport:off - a linked Node entry exercises Node's real argv behavior.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

it.effect.skipIf(!symlinksSupported)(
  "resolves the actual server entry behind a t3 executable symlink",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-worker-entry-" });
      const root = yield* fs.realPath(directory);
      const entry = path.join(root, "bin.mjs");
      const link = path.join(root, "t3");
      const helper = NodeURL.fileURLToPath(new URL("./serverWorkerCommand.ts", import.meta.url));
      yield* fs.writeFileString(
        entry,
        `import {resolveServerWorkerCommand} from ${JSON.stringify(NodeURL.pathToFileURL(helper).href)}; console.log(JSON.stringify(resolveServerWorkerCommand("__html-preview")));`,
      );
      yield* fs.symlink(entry, link);
      const child = yield* spawner.spawn(ChildProcess.make(process.execPath, [link]));
      const [output, code] = yield* Effect.all(
        [child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
        { concurrency: "unbounded" },
      );
      expect(code).toBe(0);
      expect(JSON.parse(output)).toEqual({
        command: process.execPath,
        args: [entry, "__html-preview"],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
