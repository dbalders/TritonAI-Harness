import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { PNG } from "pngjs";

it.layer(NodeServices.layer)("runtime branding", (it) => {
  it.effect(
    "preserves the Aurora trident and central artwork in the macOS-only square source",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
        const original = PNG.sync.read(
          Buffer.from(
            yield* fs.readFile(path.join(repoRoot, "assets/dev/tritonai-harness-dev-1024.png")),
          ),
        );
        const square = PNG.sync.read(
          Buffer.from(
            yield* fs.readFile(
              path.join(repoRoot, "assets/dev/macos-app-icon.icon/Assets/logo.png"),
            ),
          ),
        );
        assert.deepEqual([square.width, square.height], [original.width, original.height]);
        assert.isTrue(square.data.every((value, index) => index % 4 !== 3 || value === 255));
        assert.isTrue(
          original.data.every((value, index) => {
            const pixel = Math.floor(index / 4);
            const offset = pixel * 4;
            const isTrident =
              original.data[offset]! > 225 &&
              original.data[offset + 1]! > 225 &&
              original.data[offset + 2]! > 225;
            const isCenter =
              Math.hypot((pixel % 1024) - 511.5, Math.floor(pixel / 1024) - 511.5) < 430;
            return (
              index % 4 === 3 ||
              original.data[offset + 3] !== 255 ||
              (!isTrident && !isCenter) ||
              value === square.data[index]
            );
          }),
          "The existing white trident and central Aurora artwork must stay unchanged.",
        );
      }),
  );

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

  it.effect("ships rounded-square macOS icons at the standard Dock footprint", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      for (const source of [
        "assets/dev/tritonai-harness-dev-macos-1024.png",
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
        const centerRow = Math.floor(icon.height / 2);
        const visible = Array.from({ length: icon.width }, (_, x) => x).filter(
          (x) => alphaAt(x, centerRow)! >= 128,
        );
        assert.closeTo(visible.length / icon.width, 0.84, 0.005);
        assert.isAtLeast(visible[0]!, 80);
        assert.isAtMost(visible.at(-1)!, icon.width - 81);
        const centerColumn = Math.floor(icon.width / 2);
        const visibleHeight = Array.from({ length: icon.height }, (_, y) => y).filter(
          (y) => alphaAt(centerColumn, y)! >= 128,
        );
        assert.closeTo(visibleHeight.length / icon.height, 0.84, 0.005);
        assert.closeTo(visible[0]!, icon.width - 1 - visible.at(-1)!, 1);
        assert.closeTo(visibleHeight[0]!, icon.height - 1 - visibleHeight.at(-1)!, 1);
        // Inside the padded rounded square, outside a padded circular badge.
        assert.isAtLeast(alphaAt(200, 200)!, 250);
        assert.isAtLeast(alphaAt(icon.width - 201, 200)!, 250);
        assert.isAtLeast(alphaAt(200, icon.height - 201)!, 250);
        assert.isAtLeast(alphaAt(icon.width - 201, icon.height - 201)!, 250);
      }
    }),
  );
});
