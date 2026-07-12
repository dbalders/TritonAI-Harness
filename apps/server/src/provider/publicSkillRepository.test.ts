import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  make,
  PublicSkillRepository,
  type PublicSkillRepositoryOptions,
} from "./publicSkillRepository.ts";

const REVISION = "a".repeat(40);
const SECOND_REVISION = "c".repeat(40);
const TREE_SHA = "b".repeat(40);
const SECOND_TREE_SHA = "d".repeat(40);
const AI_TEAM_SKILL = `---\nname: tritonai-feedback\ndescription: Send feedback to the TritonAI team.\n---\n`;
const COMMUNITY_SKILL = `---\nname: campus-helper\ndescription: Help with a campus workflow.\nmaintainer: Jane Triton\n---\n`;

interface RepositoryCall {
  readonly url: string;
  readonly authorization: string | undefined;
}

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
  readonly currentRevision?: () => string;
  readonly currentTree?: () => string;
  readonly failResolveAttempts?: number;
  readonly hangResolve?: boolean;
  readonly rateLimitOnce?: boolean;
  readonly symlink?: boolean;
  readonly truncated?: boolean;
  readonly calls?: RepositoryCall[];
}) {
  let resolveAttempts = 0;
  let rateLimited = false;
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
      input?.calls?.push({
        url: request.url,
        authorization: request.headers.authorization,
      });
      const url = new URL(request.url);
      let response: Response;
      if (url.pathname.includes("/commits/")) {
        if (input?.hangResolve) return Effect.never;
        resolveAttempts += 1;
        if (input?.rateLimitOnce && !rateLimited) {
          rateLimited = true;
          response = new Response("rate limited", {
            status: 403,
            headers: { "retry-after": "60", "x-ratelimit-remaining": "0" },
          });
        } else if (resolveAttempts <= (input?.failResolveAttempts ?? 0)) {
          response = new Response("offline", { status: 503 });
        } else {
          response = Response.json({
            sha: input?.currentRevision?.() ?? REVISION,
            commit: { tree: { sha: input?.currentTree?.() ?? TREE_SHA } },
          });
        }
      } else if (url.pathname.includes("/repos/dbalders/UCSD-Skills-Library/git/trees/")) {
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

function publicSkillRepositoryLayer(
  repository: Parameters<typeof repositoryLayer>[0] = {},
  options: PublicSkillRepositoryOptions = { githubToken: null },
  env: Record<string, string> = {},
) {
  return Layer.effect(PublicSkillRepository, make(options)).pipe(
    Layer.provide(repositoryLayer(repository)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );
}

describe("public skill repository", () => {
  it.effect("discovers catalog skills over HTTPS at one exact main revision", () => {
    const calls: RepositoryCall[] = [];
    return Effect.gen(function* () {
      const repository = yield* PublicSkillRepository;
      const catalog = yield* repository.discoverCatalog;

      expect(catalog.revision).toBe(REVISION);
      expect(catalog.entries.map((entry) => [entry.id, entry.section])).toEqual([
        ["tritonai/tritonai-feedback", "ai-team"],
        ["community/campus-helper", "community"],
      ]);
      expect(catalog.entries[1]?.maintainer).toBe("Jane Triton");
      expect(calls.map((call) => call.url)).toContain(
        "https://api.github.com/repos/dbalders/UCSD-Skills-Library/commits/main",
      );
      expect(calls.map((call) => call.url)).toContain(
        `https://api.github.com/repos/dbalders/UCSD-Skills-Library/git/trees/${TREE_SHA}?recursive=1`,
      );
      expect(calls.map((call) => call.url)).toContain(
        `https://raw.githubusercontent.com/dbalders/UCSD-Skills-Library/${REVISION}/tritonai/tritonai-feedback/SKILL.md`,
      );
    }).pipe(Effect.provide(publicSkillRepositoryLayer({ calls })));
  });

  it.effect("single-flights concurrent discovery and reuses the success within its TTL", () => {
    const calls: RepositoryCall[] = [];
    return Effect.gen(function* () {
      const repository = yield* PublicSkillRepository;
      const catalogs = yield* Effect.all([repository.discoverCatalog, repository.discoverCatalog], {
        concurrency: "unbounded",
      });
      const third = yield* repository.discoverCatalog;

      expect(catalogs[0]).toEqual(catalogs[1]);
      expect(third).toEqual(catalogs[0]);
      expect(calls).toHaveLength(4);
    }).pipe(Effect.provide(publicSkillRepositoryLayer({ calls })));
  });

  it.effect("refreshes the mutable catalog after its TTL without mixing revisions", () => {
    const calls: RepositoryCall[] = [];
    let revision = REVISION;
    let tree = TREE_SHA;
    return Effect.gen(function* () {
      const repository = yield* PublicSkillRepository;
      const first = yield* repository.discoverCatalog;
      revision = SECOND_REVISION;
      tree = SECOND_TREE_SHA;

      yield* TestClock.adjust("59 seconds");
      const cached = yield* repository.discoverCatalog;
      yield* TestClock.adjust("2 seconds");
      const refreshed = yield* repository.discoverCatalog;

      expect(first.revision).toBe(REVISION);
      expect(cached.revision).toBe(REVISION);
      expect(refreshed.revision).toBe(SECOND_REVISION);
      expect(calls.filter((call) => call.url.endsWith("/commits/main"))).toHaveLength(2);
      expect(calls.some((call) => call.url.includes(`/git/trees/${SECOND_TREE_SHA}`))).toBe(true);
      expect(
        calls.some((call) =>
          call.url.includes(`raw.githubusercontent.com/dbalders/UCSD-Skills-Library/${REVISION}/`),
        ),
      ).toBe(true);
      expect(
        calls.some((call) =>
          call.url.includes(
            `raw.githubusercontent.com/dbalders/UCSD-Skills-Library/${SECOND_REVISION}/`,
          ),
        ),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        publicSkillRepositoryLayer(
          { calls, currentRevision: () => revision, currentTree: () => tree },
          { catalogTtl: "1 minute" },
        ),
      ),
    );
  });

  it.effect("does not cache discovery failures", () => {
    const calls: RepositoryCall[] = [];
    return Effect.gen(function* () {
      const repository = yield* PublicSkillRepository;
      const error = yield* Effect.flip(repository.discoverCatalog);
      const catalog = yield* repository.discoverCatalog;

      expect(error.message).toContain("could not be reached");
      expect(catalog.revision).toBe(REVISION);
      expect(calls.filter((call) => call.url.endsWith("/commits/main"))).toHaveLength(2);
    }).pipe(Effect.provide(publicSkillRepositoryLayer({ calls, failResolveAttempts: 1 })));
  });

  it.effect("times out when the public source does not respond", () =>
    Effect.gen(function* () {
      const repository = yield* PublicSkillRepository;
      const errorFiber = yield* repository.discoverCatalog.pipe(Effect.flip, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("15 seconds");
      const error = yield* Fiber.join(errorFiber);

      expect(error.message).toContain("Request timed out");
    }).pipe(Effect.provide(publicSkillRepositoryLayer({ hangResolve: true }))),
  );

  it.effect("rejects a truncated GitHub tree", () =>
    Effect.gen(function* () {
      const repository = yield* PublicSkillRepository;
      const error = yield* Effect.flip(repository.discoverCatalog);
      expect(error.message).toContain("truncated tree");
    }).pipe(Effect.provide(publicSkillRepositoryLayer({ truncated: true }))),
  );

  it.effect("reuses immutable commit, tree, and content results for pinned installs", () => {
    const calls: RepositoryCall[] = [];
    return Effect.gen(function* () {
      const repository = yield* PublicSkillRepository;
      yield* repository.discoverCatalog;
      const first = yield* repository.loadBundle({
        id: "tritonai/tritonai-feedback",
        revision: REVISION,
      });
      const second = yield* repository.loadBundle({
        id: "tritonai/tritonai-feedback",
        revision: REVISION,
      });

      expect(first).toEqual(second);
      expect(first.files.find((file) => file.path === "SKILL.md")?.content).toBe(AI_TEAM_SKILL);
      expect(calls.filter((call) => call.url.includes("/commits/"))).toHaveLength(1);
      expect(calls.filter((call) => call.url.includes("/git/trees/"))).toHaveLength(1);
      expect(calls.filter((call) => call.url.endsWith("/references/info.md"))).toHaveLength(1);
    }).pipe(Effect.provide(publicSkillRepositoryLayer({ calls })));
  });

  it.effect("suppresses upstream requests during a rate-limit cooldown", () => {
    const calls: RepositoryCall[] = [];
    return Effect.gen(function* () {
      const repository = yield* PublicSkillRepository;
      const limited = yield* Effect.flip(repository.discoverCatalog);
      const coolingDown = yield* Effect.flip(repository.discoverCatalog);

      expect(limited.message).toContain("rate limit was reached");
      expect(coolingDown.message).toContain("cooldown is active");
      expect(calls).toHaveLength(1);

      yield* TestClock.adjust("61 seconds");
      const catalog = yield* repository.discoverCatalog;
      expect(catalog.revision).toBe(REVISION);
      expect(calls).toHaveLength(5);
    }).pipe(Effect.provide(publicSkillRepositoryLayer({ calls, rateLimitOnce: true })));
  });

  it.effect("keeps optional server authorization off raw-content requests", () => {
    const calls: RepositoryCall[] = [];
    return Effect.gen(function* () {
      const repository = yield* PublicSkillRepository;
      yield* repository.discoverCatalog;

      const apiCalls = calls.filter((call) => call.url.startsWith("https://api.github.com/"));
      const rawCalls = calls.filter((call) =>
        call.url.startsWith("https://raw.githubusercontent.com/"),
      );
      expect(apiCalls.every((call) => call.authorization === "Bearer test-token")).toBe(true);
      expect(rawCalls.every((call) => call.authorization === undefined)).toBe(true);
    }).pipe(
      Effect.provide(
        publicSkillRepositoryLayer(
          { calls },
          {},
          { TRITONAI_PUBLIC_SKILLS_GITHUB_TOKEN: "test-token" },
        ),
      ),
    );
  });

  it.effect("rejects symlinks in public skill bundles", () =>
    Effect.gen(function* () {
      const repository = yield* PublicSkillRepository;
      const error = yield* Effect.flip(
        repository.loadBundle({ id: "tritonai/tritonai-feedback", revision: REVISION }),
      );
      expect(error.message).toContain("cannot contain symlinks");
    }).pipe(Effect.provide(publicSkillRepositoryLayer({ symlink: true }))),
  );
});
