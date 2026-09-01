import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

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
});
