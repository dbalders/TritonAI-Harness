import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerProviderSkillCatalog } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import {
  layer,
  make,
  type PublicSkillCatalogSnapshotStore,
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

const SAVED_CATALOG: ServerProviderSkillCatalog = {
  version: 1,
  repositoryUrl: "https://github.com/dbalders/UCSD-Skills-Library",
  revision: SECOND_REVISION,
  fetchedAt: "2026-10-01T00:00:00.000Z",
  entries: [],
};

function memorySnapshot(initial: ServerProviderSkillCatalog | null) {
  const written: ServerProviderSkillCatalog[] = [];
  const store: PublicSkillCatalogSnapshotStore = {
    read: Effect.succeed(initial),
    write: (catalog) => Effect.sync(() => void written.push(catalog)),
  };
  return { store, written };
}

/** Dependencies of the production `layer`, which reads the state dir as it starts. */
function stateDirDependencies(repository: Parameters<typeof repositoryLayer>[0] = {}) {
  return ServerConfig.layerTest(process.cwd(), { prefix: "t3-public-skills-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(repositoryLayer(repository)),
    Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
  );
}

const CatalogJson = Schema.fromJsonString(ServerProviderSkillCatalog);

const snapshotFilePath = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.stateDir, "public-skill-catalog.json");
});

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

  it.effect("serves the saved catalog without waiting on GitHub", () => {
    const snapshot = memorySnapshot(SAVED_CATALOG);
    return Effect.gen(function* () {
      const repository = yield* PublicSkillRepository;
      const read = yield* repository.readCatalog;

      expect(read).toEqual({ catalog: SAVED_CATALOG, stale: true });
    }).pipe(
      Effect.provide(
        publicSkillRepositoryLayer(
          { hangResolve: true },
          { githubToken: null, snapshot: snapshot.store },
        ),
      ),
    );
  });

  it.effect("replaces and saves the catalog after a refresh", () => {
    const calls: RepositoryCall[] = [];
    const snapshot = memorySnapshot(SAVED_CATALOG);
    return Effect.gen(function* () {
      const repository = yield* PublicSkillRepository;
      const saved = yield* repository.readCatalog;
      const refreshed = yield* repository.refreshCatalog();
      const next = yield* repository.readCatalog;

      expect(saved.catalog.revision).toBe(SECOND_REVISION);
      expect(refreshed.stale).toBe(false);
      expect(refreshed.catalog.revision).toBe(REVISION);
      expect(next).toEqual(refreshed);
      expect(snapshot.written.map((catalog) => catalog.revision)).toEqual([REVISION]);
      expect(calls.filter((call) => call.url.endsWith("/commits/main"))).toHaveLength(1);
    }).pipe(
      Effect.provide(
        publicSkillRepositoryLayer({ calls }, { githubToken: null, snapshot: snapshot.store }),
      ),
    );
  });

  it.effect("keeps the saved catalog when a refresh fails", () => {
    const snapshot = memorySnapshot(SAVED_CATALOG);
    return Effect.gen(function* () {
      const repository = yield* PublicSkillRepository;
      const refreshed = yield* repository.refreshCatalog();

      expect(refreshed).toEqual({ catalog: SAVED_CATALOG, stale: true });
      expect(snapshot.written).toEqual([]);
    }).pipe(
      Effect.provide(
        publicSkillRepositoryLayer(
          { failResolveAttempts: 1 },
          { githubToken: null, snapshot: snapshot.store },
        ),
      ),
    );
  });

  it.effect("waits for GitHub on the first read when nothing is saved", () => {
    const calls: RepositoryCall[] = [];
    return Effect.gen(function* () {
      const repository = yield* PublicSkillRepository;
      const first = yield* repository.readCatalog;
      const second = yield* repository.readCatalog;

      expect(first.stale).toBe(false);
      expect(first.catalog.revision).toBe(REVISION);
      expect(second).toEqual(first);
      expect(calls).toHaveLength(4);
    }).pipe(Effect.provide(publicSkillRepositoryLayer({ calls })));
  });

  it.effect("saves a refreshed catalog in the state directory", () =>
    Effect.gen(function* () {
      const repository = yield* PublicSkillRepository;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* repository.refreshCatalog();

      const saved = yield* Schema.decodeEffect(CatalogJson)(
        yield* fileSystem.readFileString(yield* snapshotFilePath),
      );
      expect(saved.revision).toBe(REVISION);
      expect(saved.entries).toHaveLength(2);
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(stateDirDependencies())))),
  );

  it.effect("restores the catalog saved by an earlier run", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(
        yield* snapshotFilePath,
        yield* Schema.encodeEffect(CatalogJson)(SAVED_CATALOG),
      );
      const read = yield* PublicSkillRepository.pipe(
        Effect.flatMap((repository) => repository.readCatalog),
        Effect.provide(layer),
      );

      expect(read).toEqual({ catalog: SAVED_CATALOG, stale: true });
    }).pipe(Effect.provide(stateDirDependencies({ hangResolve: true }))),
  );

  it.effect("ignores an unreadable saved catalog", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(yield* snapshotFilePath, "{ not a catalog");
      const read = yield* PublicSkillRepository.pipe(
        Effect.flatMap((repository) => repository.readCatalog),
        Effect.provide(layer),
      );

      expect(read.stale).toBe(false);
      expect(read.catalog.revision).toBe(REVISION);
    }).pipe(Effect.provide(stateDirDependencies())),
  );

  it.effect("checks GitHub as soon as the service starts", () => {
    const written = Deferred.makeUnsafe<ServerProviderSkillCatalog>();
    const store: PublicSkillCatalogSnapshotStore = {
      read: Effect.succeed(SAVED_CATALOG),
      write: (catalog) => Deferred.succeed(written, catalog).pipe(Effect.asVoid),
    };
    return Effect.gen(function* () {
      yield* PublicSkillRepository;
      const refreshed = yield* Deferred.await(written);

      expect(refreshed.revision).toBe(REVISION);
    }).pipe(
      Effect.provide(
        publicSkillRepositoryLayer(
          {},
          { githubToken: null, snapshot: store, refreshOnStart: true },
        ),
      ),
    );
  });

  it.effect("fetches a fresh catalog on a forced refresh within the TTL", () => {
    const calls: RepositoryCall[] = [];
    let revision = REVISION;
    let tree = TREE_SHA;
    return Effect.gen(function* () {
      const repository = yield* PublicSkillRepository;
      const first = yield* repository.refreshCatalog();
      revision = SECOND_REVISION;
      tree = SECOND_TREE_SHA;
      const unforced = yield* repository.refreshCatalog();
      const forced = yield* repository.refreshCatalog({ force: true });

      expect(first.catalog.revision).toBe(REVISION);
      expect(unforced.catalog.revision).toBe(REVISION);
      expect(forced).toEqual({
        catalog: expect.objectContaining({ revision: SECOND_REVISION }),
        stale: false,
      });
      expect(calls.filter((call) => call.url.endsWith("/commits/main"))).toHaveLength(2);
    }).pipe(
      Effect.provide(
        publicSkillRepositoryLayer({
          calls,
          currentRevision: () => revision,
          currentTree: () => tree,
        }),
      ),
    );
  });
});
