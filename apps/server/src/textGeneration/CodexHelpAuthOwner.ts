import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as CodexClient from "effect-codex-app-server/client";
import { TextGenerationError } from "@t3tools/contracts";
import { resolveCodexAppServerCommand } from "../provider/Drivers/CodexAppServerCommand.ts";

const owners = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();

/** Ask only the canonical auth manager to renew access; never send it a prompt or start a turn. */
export const withCodexHelpAuthOwner = Effect.fn("withCodexHelpAuthOwner")(function* <A, E, R>(
  input: {
    readonly binary: string;
    readonly home: string;
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
  },
  readSnapshot: (canonicalHome: string) => Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const canonicalHome = yield* fs.realPath(input.home);
  const owner = owners.get(canonicalHome) ?? { lock: Semaphore.makeUnsafe(1), users: 0 };
  owner.users++;
  owners.set(canonicalHome, owner);
  return yield* owner.lock
    .withPermits(1)(
      Effect.scoped(
        Effect.gen(function* () {
          const environment = { ...input.environment, CODEX_HOME: canonicalHome };
          const command = yield* resolveCodexAppServerCommand(
            input.binary,
            [
              "app-server",
              "--config",
              'model_provider="openai"',
              "--config",
              'cli_auth_credentials_store="file"',
              "--config",
              "features.plugins=false",
              "--config",
              "features.apps=false",
            ],
            { env: environment, extendEnv: false },
          );
          const child = yield* spawner.spawn(
            ChildProcess.make(command.command, command.args, {
              env: command.environment,
              extendEnv: command.extendEnv,
              shell: command.shell,
              cwd: input.cwd,
              forceKillAfter: "1 second",
            }),
          );
          const context = yield* Layer.build(CodexClient.layerChildProcess(child));
          const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
            Effect.provide(context),
          );
          yield* client.request("initialize", {
            clientInfo: { name: "tritonai_help_auth", version: "1" },
            capabilities: { experimentalApi: false },
          });
          yield* client.notify("initialized", undefined);
          // Unlike account/read with its default flag, getAuthStatus invokes
          // AuthManager.auth(), which proactively renews expired access in place.
          // No token is exported over this protocol.
          const status = yield* client.request("getAuthStatus", {
            includeToken: false,
            refreshToken: false,
          });
          if (
            status.authMethod === null ||
            status.authToken !== null ||
            status.requiresOpenaiAuth !== true
          )
            return yield* Effect.fail(
              new TextGenerationError({
                operation: "generateHelp",
                detail: "Native Help authentication is unavailable.",
              }),
            );
          return yield* readSnapshot(canonicalHome);
        }),
      ),
    )
    .pipe(
      Effect.timeout("20 seconds"),
      Effect.ensuring(
        Effect.sync(() => {
          owner.users--;
          if (owner.users === 0) owners.delete(canonicalHome);
        }),
      ),
    );
});
