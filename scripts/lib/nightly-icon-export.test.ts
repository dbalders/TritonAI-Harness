import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path } from "effect";
import { PNG } from "pngjs";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { BRAND_ASSET_PATHS } from "./brand-assets.ts";
import { renderNightlyIconAssets, resizeNightlyIcon } from "./nightly-icon-export.ts";

it("downsamples transparency without dark color fringes", () => {
  const source = new PNG({ width: 2, height: 2 });
  source.data.fill(0);
  source.data.set([255, 255, 255, 255], 0);
  const small = PNG.sync.read(resizeNightlyIcon(source, 1));
  expect([...small.data]).toEqual([255, 255, 255, 64]);
});

it.layer(NodeServices.layer)("nightly artwork", (it) => {
  it.effect("ships transparent artwork and current PNG/ICO exports from the approved master", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url));
      const master = Buffer.from(
        yield* fs.readFile(path.join(root, BRAND_ASSET_PATHS.nightlyMacIconPng)),
      );
      const image = PNG.sync.read(master);
      expect([image.width, image.height]).toEqual([1024, 1024]);
      for (const [x, y] of [
        [0, 0],
        [1023, 0],
        [0, 1023],
        [1023, 1023],
      ] as const) {
        expect(image.data[(y * 1024 + x) * 4 + 3]).toBe(0);
      }
      expect(image.data[(512 * 1024 + 512) * 4 + 3]).toBe(255);
      const stable = Buffer.from(
        yield* fs.readFile(path.join(root, BRAND_ASSET_PATHS.productionMacIconPng)),
      );
      expect(master.equals(stable)).toBe(false);
      const outputs = renderNightlyIconAssets(master);
      for (const [file, bytes] of outputs) {
        expect(Buffer.from(yield* fs.readFile(path.join(root, file))).equals(bytes)).toBe(true);
      }
      const ico = outputs.get(BRAND_ASSET_PATHS.nightlyWindowsIconIco)!;
      expect(ico.readUInt16LE(4)).toBe(7);
      const touch = PNG.sync.read(outputs.get(BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng)!);
      expect([touch.width, touch.height, touch.data[3]]).toEqual([180, 180, 255]);
    }),
  );
});
