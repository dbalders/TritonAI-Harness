import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { Argument, Command } from "effect/unstable/cli";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessRunner from "../processRunner.ts";
import {
  type ManagedCodexUpdateError,
  managedCodexUpdateCommandName,
  updateTritonAiManagedCodex,
} from "../provider/managedCodexUpdate.ts";

export const managedCodexUpdateCommand = Command.make(managedCodexUpdateCommandName, {
  binaryPath: Argument.string("binary-path"),
}).pipe(
  Command.withDescription("Update the TritonAI-managed Codex runtime."),
  Command.unlisted,
  Command.withHandler(({ binaryPath }) =>
    Effect.gen(function* () {
      const processRunner = yield* ProcessRunner.make();
      const version = yield* updateTritonAiManagedCodex({
        binaryPath,
        run: processRunner.run,
      });
      yield* Console.log(`Updated the TritonAI-managed Codex runtime to ${version}.`);
    }),
  ),
);
