#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

const ADAPTIVE_CANVAS = 432;
const SPLASH_CANVAS = 1152;
const OUTPUT_DIRECTORY = "apps/mobile/assets";

export class AndroidIconRenderError extends Schema.TaggedError<AndroidIconRenderError>()(
  "AndroidIconRenderError",
  { layer: Schema.String, cause: Schema.Defect() },
) {}

const render = (layer: string, operation: () => Promise<Buffer>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const exportAndroidIcons = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const outputs = new Map<string, Buffer>();

  // The complete square artwork lives in the adaptive background. Android owns the mask.
  outputs.set(
    "android-icon-foreground-release.png",
    yield* render("empty-foreground", () =>
      sharp({
        create: {
          width: ADAPTIVE_CANVAS,
          height: ADAPTIVE_CANVAS,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .png()
        .toBuffer(),
    ),
  );
  for (const [variant, project, background] of [
    ["prod", BRAND_ASSET_PATHS.productionIconComposerProject, "android-icon-background.png"],
    [
      "nightly",
      BRAND_ASSET_PATHS.nightlyIconComposerProject,
      "android-icon-background-nightly.png",
    ],
  ] as const) {
    const master = Buffer.from(
      yield* fs.readFile(path.join(repositoryRoot, project, "Assets/logo.png")),
    );
    outputs.set(
      background,
      yield* render(background, () =>
        sharp(master).resize(ADAPTIVE_CANVAS, ADAPTIVE_CANVAS).png().toBuffer(),
      ),
    );
    outputs.set(
      `android-splash-icon-${variant}.png`,
      yield* render(`${variant}-splash`, () =>
        sharp(master).resize(SPLASH_CANVAS, SPLASH_CANVAS).png().toBuffer(),
      ),
    );
    if (variant === "prod") {
      const silhouette = yield* render("triton-silhouette", async () => {
        const alpha = await sharp(master).extractChannel("red").threshold(200).toBuffer();
        return sharp({
          create: { width: 1024, height: 1024, channels: 3, background: "#FFFFFF" },
        })
          .joinChannel(alpha)
          .png()
          .toBuffer();
      });
      outputs.set(
        "android-icon-mark.png",
        yield* render("monochrome", () =>
          sharp(silhouette).resize(ADAPTIVE_CANVAS, ADAPTIVE_CANVAS).png().toBuffer(),
        ),
      );
      outputs.set(
        "android-notification-icon.png",
        yield* render("notification", () =>
          sharp(silhouette)
            .trim()
            .resize(96, 96, { fit: "contain", background: "#00000000" })
            .png()
            .toBuffer(),
        ),
      );
    }
  }
  for (const [name, contents] of outputs) {
    yield* fs.writeFile(path.join(repositoryRoot, OUTPUT_DIRECTORY, name), contents);
    yield* Console.log(`wrote ${OUTPUT_DIRECTORY}/${name}`);
  }
});

if (import.meta.main) {
  exportAndroidIcons.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
