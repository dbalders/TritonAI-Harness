import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { discoverPublicSkillCatalog, loadPublicSkillBundle } from "./publicSkillRepository.ts";

const REVISION = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const AI_TEAM_SKILL = `---\nname: tritonai-feedback\ndescription: Send feedback to the TritonAI team.\n---\n`;
const COMMUNITY_SKILL = `---\nname: campus-helper\ndescription: Help with a campus workflow.\nmaintainer: Jane Triton\n---\n`;

function treeEntry(input: {
  readonly path: string;
  readonly sha: string;
  readonly size: number;
  readonly mode?: string;
}) {
  return {
    path: input.path,
    mode: input.mode ?? "100644",
    type: "blob",
    sha: input.sha,
    size: input.size,
  };
}

function repositoryLayer(input?: {
  readonly failResolve?: boolean;
  readonly symlink?: boolean;
  readonly truncated?: boolean;
  readonly calls?: string[];
}) {
  const tree = [
    {
      path: "tritonai/tritonai-feedback/references",
      mode: "040000",
      type: "tree",
      sha: "4".repeat(40),
    },
    treeEntry({
      path: "tritonai/tritonai-feedback/SKILL.md",
      sha: "1".repeat(40),
      size: Buffer.byteLength(AI_TEAM_SKILL),
    }),
    treeEntry({
      path: "tritonai/tritonai-feedback/references/info.md",
      sha: "3".repeat(40),
      size: Buffer.byteLength("Reference content\n"),
      ...(input?.symlink ? { mode: "120000" } : {}),
    }),
    treeEntry({
      path: "community/campus-helper/SKILL.md",
      sha: "2".repeat(40),
      size: Buffer.byteLength(COMMUNITY_SKILL),
    }),
  ];

  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      input?.calls?.push(request.url);
      const url = new URL(request.url);
      let response: Response;
      if (url.pathname.includes("/commits/")) {
        response = input?.failResolve
          ? new Response("offline", { status: 503 })
          : Response.json({ sha: REVISION, commit: { tree: { sha: TREE_SHA } } });
      } else if (url.pathname === `/repos/dbalders/UCSD-Skills-Library/git/trees/${TREE_SHA}`) {
        response = Response.json({ truncated: input?.truncated ?? false, tree });
      } else if (url.pathname.endsWith("/tritonai/tritonai-feedback/SKILL.md")) {
        response = new Response(AI_TEAM_SKILL);
      } else if (url.pathname.endsWith("/tritonai/tritonai-feedback/references/info.md")) {
        response = new Response("Reference content\n");
      } else if (url.pathname.endsWith("/community/campus-helper/SKILL.md")) {
        response = new Response(COMMUNITY_SKILL);
      } else {
        response = new Response("not found", { status: 404 });
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    }),
  );
}

describe("public skill repository", () => {
  it.effect("discovers catalog skills over HTTPS at one exact main revision", () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const catalog = yield* discoverPublicSkillCatalog();

      expect(catalog.revision).toBe(REVISION);
      expect(catalog.entries.map((entry) => [entry.id, entry.section])).toEqual([
        ["tritonai/tritonai-feedback", "ai-team"],
        ["community/campus-helper", "community"],
      ]);
      expect(catalog.entries[1]?.maintainer).toBe("Jane Triton");
      expect(calls).toContain(
        "https://api.github.com/repos/dbalders/UCSD-Skills-Library/commits/main",
      );
      expect(calls).toContain(
        `https://api.github.com/repos/dbalders/UCSD-Skills-Library/git/trees/${TREE_SHA}?recursive=1`,
      );
      expect(calls).toContain(
        `https://raw.githubusercontent.com/dbalders/UCSD-Skills-Library/${REVISION}/tritonai/tritonai-feedback/SKILL.md`,
      );
    }).pipe(Effect.provide(repositoryLayer({ calls })));
  });

  it.effect("reports an explicit discovery error when the public source is unavailable", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(discoverPublicSkillCatalog());
      expect(error.message).toContain("could not be reached");
    }).pipe(Effect.provide(repositoryLayer({ failResolve: true }))),
  );

  it.effect("rejects a truncated GitHub tree", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(discoverPublicSkillCatalog());
      expect(error.message).toContain("truncated tree");
    }).pipe(Effect.provide(repositoryLayer({ truncated: true }))),
  );

  it.effect("installs a catalog skill from the exact revision supplied by discovery", () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const result = yield* loadPublicSkillBundle({
        id: "tritonai/tritonai-feedback",
        revision: REVISION,
      });

      expect(result.skillId).toBe("tritonai-feedback");
      expect(result.files.find((file) => file.path === "SKILL.md")?.content).toBe(AI_TEAM_SKILL);
      expect(calls).toContain(
        `https://api.github.com/repos/dbalders/UCSD-Skills-Library/commits/${REVISION}`,
      );
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
