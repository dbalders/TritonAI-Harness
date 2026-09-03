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

  it.effect("uses stage-aware TritonAI branding in the mobile app and launcher", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const appConfig = yield* fs.readFileString(path.join(repoRoot, "apps/mobile/app.config.ts"));
      const brandMark = yield* fs.readFileString(
        path.join(repoRoot, "apps/mobile/src/components/BrandMark.tsx"),
      );

      assert.include(appConfig, "BRAND_ASSET_PATHS.developmentIosIconPng");
      assert.include(appConfig, "BRAND_ASSET_PATHS.productionIosIconPng");
      assert.include(brandMark, "assets/dev/tritonai-harness-dev-1024.png");
      assert.include(brandMark, "assets/prod/tritonai-logo.png");
      assert.notInclude(brandMark, "assets/prod/tritonai-harness-1024.png");
    }),
  );

  it.effect("keeps the production macOS icon full-size with transparent corners", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const contents = yield* fs.readFile(
        path.join(repoRoot, "assets/prod/tritonai-harness-1024.png"),
      );
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
      assert.deepEqual(
        [
          alphaAt(Math.floor(icon.width / 2), 0),
          alphaAt(icon.width - 1, Math.floor(icon.height / 2)),
          alphaAt(Math.floor(icon.width / 2), icon.height - 1),
          alphaAt(0, Math.floor(icon.height / 2)),
        ],
        [255, 255, 255, 255],
      );
    }),
  );
});
