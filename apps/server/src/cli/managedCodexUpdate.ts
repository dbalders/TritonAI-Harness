import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/cli";
import * as ProcessRunner from "../processRunner.ts";
import {
  managedCodexUpdateCommandName,
  updateTritonAiManagedCodex,
} from "../provider/managedCodexUpdate.ts";

export const managedCodexUpdateCommand = Command.make(managedCodexUpdateCommandName, {
  binaryPath: Argument.String("binary-path"),
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
