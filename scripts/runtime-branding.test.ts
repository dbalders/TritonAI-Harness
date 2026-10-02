import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { PNG } from "pngjs";

it.layer(NodeServices.layer)("runtime branding", (it) => {
  it.effect("keeps the web boot logo independent from environment app icons", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const indexHtml = yield* fs.readFileString(path.join(repoRoot, "apps/web/index.html"));
      const runtimeLogo = yield* fs.readFile(
        path.join(repoRoot, "apps/web/public/tritonai-logo.png"),
      );
      const productionLogo = yield* fs.readFile(
        path.join(repoRoot, "assets/prod/tritonai-logo.png"),
      );

      assert.include(indexHtml, 'id="boot-shell-logo" src="/tritonai-logo.png"');
      assert.deepEqual(runtimeLogo, productionLogo);
    }),
  );

  it.effect("ships rounded-square macOS icons that fill the canvas", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      for (const source of [
        "assets/prod/tritonai-harness-1024.png",
        "assets/nightly/tritonai-harness-nightly-1024.png",
      ]) {
        const contents = yield* fs.readFile(path.join(repoRoot, source));
        const icon = PNG.sync.read(Buffer.from(contents));
        const alphaAt = (x: number, y: number) => icon.data[(y * icon.width + x) * 4 + 3];

        assert.deepEqual([icon.width, icon.height], [1024, 1024]);
        assert.deepEqual(
          [
            alphaAt(0, 0),
            alphaAt(icon.width - 1, 0),
            alphaAt(0, icon.height - 1),
            alphaAt(icon.width - 1, icon.height - 1),
          ],
          [0, 0, 0, 0],
        );
        // This corner is inside a rounded square but outside the former circular badge.
        assert.isAtLeast(alphaAt(128, 128)!, 250);
        assert.isAtLeast(alphaAt(icon.width - 129, 128)!, 250);
        assert.isAtLeast(alphaAt(128, icon.height - 129)!, 250);
        assert.isAtLeast(alphaAt(icon.width - 129, icon.height - 129)!, 250);
      }
    }),
  );
});
