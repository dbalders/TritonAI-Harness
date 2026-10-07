import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path } from "effect";
import { PNG } from "pngjs";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./brand-assets.ts";
import { renderDevelopmentIconAssets, resizeNightlyIcon } from "./nightly-icon-export.ts";

it("downsamples transparency without dark color fringes", () => {
  const source = new PNG({ width: 2, height: 2 });
  source.data.fill(0);
  source.data.set([255, 255, 255, 255], 0);
  const small = PNG.sync.read(resizeNightlyIcon(source, 1));
  expect([...small.data]).toEqual([255, 255, 255, 64]);
});

it.layer(NodeServices.layer)("development artwork", (it) => {
  it.effect("ships current Aurora exports, opaque iOS artwork, and synchronized web icons", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url));
      const master = Buffer.from(
        yield* fs.readFile(path.join(root, BRAND_ASSET_PATHS.developmentIconMasterPng)),
      );
      const image = PNG.sync.read(master);
      expect([image.width, image.height]).toEqual([1024, 1024]);
      for (const [x, y] of [
        [0, 0],
        [1023, 0],
        [0, 1023],
        [1023, 1023],
      ] as const)
        expect(image.data[(y * 1024 + x) * 4 + 3]).toBe(0);
      // Allow the raster master's narrow antialiased rim, but reject the old 100px inset.
      for (const [x, y] of [
        [512, 8],
        [8, 512],
        [1015, 512],
        [512, 1015],
      ] as const)
        expect(image.data[(y * 1024 + x) * 4 + 3]).toBeGreaterThanOrEqual(250);
      const outputs = renderDevelopmentIconAssets(master);
      for (const [file, bytes] of outputs)
        expect(Buffer.from(yield* fs.readFile(path.join(root, file))).equals(bytes)).toBe(true);
      const ios = PNG.sync.read(outputs.get(BRAND_ASSET_PATHS.developmentIosIconPng)!);
      expect(ios.data.every((value, index) => index % 4 !== 3 || value === 255)).toBe(true);
      for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES)
        expect(
          Buffer.from(yield* fs.readFile(path.join(root, override.targetRelativePath))).equals(
            outputs.get(override.sourceRelativePath)!,
          ),
        ).toBe(true);
    }),
  );
});

it.layer(NodeServices.layer)("square iOS artwork", (it) => {
  it.effect("ships full-bleed main and Preview masters with matching opaque fallback icons", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url));
      for (const [project, fallback] of [
        [BRAND_ASSET_PATHS.productionIconComposerProject, BRAND_ASSET_PATHS.productionIosIconPng],
        [BRAND_ASSET_PATHS.nightlyIconComposerProject, BRAND_ASSET_PATHS.nightlyIosIconPng],
      ] as const) {
        const master = Buffer.from(yield* fs.readFile(path.join(root, project, "Assets/logo.png")));
        const image = PNG.sync.read(master);
        expect([image.width, image.height]).toEqual([1024, 1024]);
        expect(image.data.every((value, index) => index % 4 !== 3 || value === 255)).toBe(true);
        expect(Buffer.from(yield* fs.readFile(path.join(root, fallback))).equals(master)).toBe(
          true,
        );
        if (project === BRAND_ASSET_PATHS.nightlyIconComposerProject) {
          // Clouds reach the lower corners rather than leaving the old flat navy exterior.
          for (const x of [0, 1023]) {
            const pixel = (1023 * 1024 + x) * 4;
            expect(image.data[pixel + 2]).toBeGreaterThan(150);
          }
        }
      }
    }),
  );
});
