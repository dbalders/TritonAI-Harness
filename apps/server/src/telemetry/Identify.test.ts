import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { getAnonymousInstallId } from "./Identify.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

it.layer(NodeServices.layer)("getAnonymousInstallId", (it) => {
  it.effect("creates one random ID and reuses it on later reads", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { anonymousIdPath } = yield* ServerConfig.ServerConfig;

      const first = yield* getAnonymousInstallId;
      const second = yield* getAnonymousInstallId;

      assert.isTrue(Option.isSome(first));
      assert.match(Option.getOrThrow(first), UUID_PATTERN);
      assert.deepEqual(second, first);
      assert.equal(
        (yield* fileSystem.readFileString(anonymousIdPath)).trim(),
        Option.getOrThrow(first),
      );
    }).pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-install-id-create-" })),
    ),
  );

  it.effect("replaces a file that does not hold a valid ID", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { anonymousIdPath } = yield* ServerConfig.ServerConfig;
      yield* fileSystem.writeFileString(anonymousIdPath, "not-an-id\n");

      const id = yield* getAnonymousInstallId;

      assert.match(Option.getOrThrow(id), UUID_PATTERN);
      assert.equal(
        (yield* fileSystem.readFileString(anonymousIdPath)).trim(),
        Option.getOrThrow(id),
      );
    }).pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-install-id-corrupt-" })),
    ),
  );

  it.effect("concurrent recoveries from an invalid file agree on one ID", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { anonymousIdPath } = yield* ServerConfig.ServerConfig;
      yield* fileSystem.writeFileString(anonymousIdPath, "not-an-id\n");

      const ids = yield* Effect.all(
        Array.from({ length: 8 }, () => getAnonymousInstallId),
        {
          concurrency: "unbounded",
        },
      );
      const onDisk = (yield* fileSystem.readFileString(anonymousIdPath)).trim();

      assert.deepEqual(new Set(ids.map(Option.getOrThrow)), new Set([onDisk]));
    }).pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-install-id-race-" })),
    ),
  );
});
