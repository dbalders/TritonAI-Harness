import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { VcsProcessSpawnError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import { discoverPublicSkillCatalog, loadPublicSkillBundle } from "./publicSkillRepository.ts";

const REVISION = "a".repeat(40);
const AI_TEAM_SKILL = `---\nname: tritonai-feedback\ndescription: Send feedback to the TritonAI team.\n---\n`;
const COMMUNITY_SKILL = `---\nname: campus-helper\ndescription: Help with a campus workflow.\nmaintainer: Jane Triton\n---\n`;

function output(stdout = ""): VcsProcess.VcsProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function treeRecord(input: {
  readonly path: string;
  readonly object: string;
  readonly size: number;
  readonly mode?: string;
}) {
  return `${input.mode ?? "100644"} blob ${input.object}   ${input.size}\t${input.path}\0`;
}

function repositoryLayer(input?: {
  readonly failResolve?: boolean;
  readonly symlink?: boolean;
  readonly calls?: VcsProcess.VcsProcessInput[];
}) {
  const objects = new Map([
    ["1".repeat(40), AI_TEAM_SKILL],
    ["2".repeat(40), COMMUNITY_SKILL],
    ["3".repeat(40), "Reference content\n"],
  ]);
  return Layer.merge(
    NodeServices.layer,
    Layer.mock(VcsProcess.VcsProcess)({
      run: (request) => {
        input?.calls?.push(request);
        if (request.args.includes("ls-remote")) {
          if (input?.failResolve) {
            return Effect.fail(
              new VcsProcessSpawnError({
                operation: request.operation,
                command: request.command,
                cwd: request.cwd,
                argumentCount: request.args.length,
                cause: PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "spawn",
                  pathOrDescriptor: request.cwd,
                  description: "offline",
                }),
              }),
            );
          }
          return Effect.succeed(output(`${REVISION}\trefs/heads/main\n`));
        }
        if (request.args.includes("ls-tree")) {
          const requestedPath = request.args.at(-1);
          if (requestedPath === "tritonai" || requestedPath === "community") {
            return Effect.succeed(
              output(
                treeRecord({
                  path: "tritonai/tritonai-feedback/SKILL.md",
                  object: "1".repeat(40),
                  size: Buffer.byteLength(AI_TEAM_SKILL),
                }) +
                  treeRecord({
                    path: "community/campus-helper/SKILL.md",
                    object: "2".repeat(40),
                    size: Buffer.byteLength(COMMUNITY_SKILL),
                  }),
              ),
            );
          }
          return Effect.succeed(
            output(
              treeRecord({
                path: "tritonai/tritonai-feedback/SKILL.md",
                object: "1".repeat(40),
                size: Buffer.byteLength(AI_TEAM_SKILL),
              }) +
                treeRecord({
                  path: "tritonai/tritonai-feedback/references/info.md",
                  object: "3".repeat(40),
                  size: Buffer.byteLength("Reference content\n"),
                  ...(input?.symlink ? { mode: "120000" } : {}),
                }),
            ),
          );
        }
        if (request.args.includes("cat-file")) {
          return Effect.succeed(output(objects.get(request.args.at(-1) ?? "") ?? ""));
        }
        return Effect.succeed(output());
      },
    }),
  );
}

describe("public skill repository", () => {
  it.effect("discovers AI Team and Community skills at one exact main revision", () => {
    const calls: VcsProcess.VcsProcessInput[] = [];
    return Effect.gen(function* () {
      const catalog = yield* discoverPublicSkillCatalog();

      expect(catalog.revision).toBe(REVISION);
      expect(catalog.entries.map((entry) => [entry.id, entry.section])).toEqual([
        ["tritonai/tritonai-feedback", "ai-team"],
        ["community/campus-helper", "community"],
      ]);
      expect(catalog.entries[1]?.maintainer).toBe("Jane Triton");
      expect(
        calls.some((call) => call.args.includes("fetch") && call.args.at(-1) === REVISION),
      ).toBe(true);
      expect(calls.every((call) => call.env?.HOME === call.cwd)).toBe(true);
    }).pipe(Effect.provide(repositoryLayer({ calls })));
  });

  it.effect("reports an explicit discovery error when the public source is unavailable", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(discoverPublicSkillCatalog());
      expect(error.message).toContain("could not be reached");
    }).pipe(Effect.provide(repositoryLayer({ failResolve: true }))),
  );

  it.effect("installs a catalog skill from the revision supplied by discovery", () => {
    const calls: VcsProcess.VcsProcessInput[] = [];
    return Effect.gen(function* () {
      const result = yield* loadPublicSkillBundle({
        id: "tritonai/tritonai-feedback",
        revision: REVISION,
      });

      expect(result.skillId).toBe("tritonai-feedback");
      expect(result.files.find((file) => file.path === "SKILL.md")?.content).toBe(AI_TEAM_SKILL);
      expect(
        calls.some((call) => call.args.includes("fetch") && call.args.at(-1) === REVISION),
      ).toBe(true);
    }).pipe(Effect.provide(repositoryLayer({ calls })));
  });

  it.effect("rejects symlinks in public skill bundles", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        loadPublicSkillBundle({ id: "tritonai/tritonai-feedback", revision: REVISION }),
      );
      expect(error.message).toContain("cannot contain symlinks");
    }).pipe(Effect.provide(repositoryLayer({ symlink: true }))),
  );
});
