#!/usr/bin/env node

// Export the approved Harness masters into Android's adaptive and splash safe zones.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

// Android guarantees the central 66dp of its 108dp adaptive canvas. The 12+
// splash mask has the same proportions, so 60% keeps the whole badge visible.
const ADAPTIVE_CANVAS = 432;
const SPLASH_CANVAS = 1152;
const BADGE_FRACTION = 0.6;
const VARIANTS = [
  { name: "dev", master: BRAND_ASSET_PATHS.developmentUniversalIconPng, color: "#0B2237" },
  { name: "nightly", master: BRAND_ASSET_PATHS.nightlyLinuxIconPng, color: "#111533" },
  { name: "prod", master: "assets/prod/tritonai-logo.png", color: "#182B49" },
] as const;

export class AndroidIconRenderError extends Schema.TaggedError<AndroidIconRenderError>()(
  "AndroidIconRenderError",
  { layer: Schema.String, cause: Schema.Defect() },
) {}

const renderBadge = (source: string, size: number, background: string) =>
  Effect.tryPromise({
    try: async () => {
      const badgeSize = Math.round(size * BADGE_FRACTION);
      const badge = await sharp(source).resize(badgeSize, badgeSize).png().toBuffer();
      return sharp({ create: { width: size, height: size, channels: 4, background } })
        .composite([{ input: badge, gravity: "centre" }])
        .png()
        .toBuffer();
    },
    catch: (cause) => new AndroidIconRenderError({ layer: source, cause }),
  });

// System-tinted icons need only the white emblem, with the navy badge removed.
// Derive every silhouette from the approved production master rather than
// maintaining a separate drawing that can drift from the Harness mark.
const renderSilhouette = (source: string, size: number, canvasSize = size) =>
  Effect.tryPromise({
    try: async () => {
      const { data, info } = await sharp(source)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      for (let i = 0; i < data.length; i += info.channels) {
        const lightness = Math.min(data[i]!, data[i + 1]!, data[i + 2]!);
        data[i + 3] = Math.round(data[i + 3]! * Math.max(0, (lightness - 128) / 127));
        data[i] = data[i + 1] = data[i + 2] = 255;
      }
      const mark = await sharp(data, { raw: info })
        .trim()
        .resize(size, size, { fit: "contain", background: "#00000000" })
        .png()
        .toBuffer();
      return sharp({
        create: { width: canvasSize, height: canvasSize, channels: 4, background: "#00000000" },
      })
        .composite([{ input: mark, gravity: "centre" }])
        .png()
        .toBuffer();
    },
    catch: (cause) => new AndroidIconRenderError({ layer: "silhouette", cause }),
  });

const exportAndroidIcons = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "..");
  const assetDirectory = path.join(root, "apps/mobile/assets");
  const write = Effect.fn("androidIcons.write")(function* (name: string, contents: Buffer) {
    yield* fs.writeFile(path.join(assetDirectory, name), contents);
    yield* Console.log(`wrote apps/mobile/assets/${name}`);
  });
  for (const variant of VARIANTS) {
    const source = path.join(root, variant.master);
    yield* write(
      variant.name === "prod"
        ? "android-icon-foreground.png"
        : `android-icon-foreground-${variant.name}.png`,
      yield* renderBadge(source, ADAPTIVE_CANVAS, "#00000000"),
    );
    yield* write(
      `android-splash-icon-${variant.name}.png`,
      yield* renderBadge(source, SPLASH_CANVAS, variant.color),
    );
  }
  const markSource = path.join(root, "assets/prod/tritonai-logo.png");
  yield* write("android-icon-mark.png", yield* renderSilhouette(markSource, 264, ADAPTIVE_CANVAS));
  const notificationMark = yield* renderSilhouette(markSource, 96);
  yield* write("android-notification-icon.png", notificationMark);
  const notificationDirectory = path.join(
    root,
    "apps/mobile/modules/t3-agent-notifications/android/src/main/res/drawable-nodpi",
  );
  yield* fs.makeDirectory(notificationDirectory, { recursive: true });
  yield* fs.writeFile(
    path.join(notificationDirectory, "agent_activity_mark.png"),
    notificationMark,
  );
});

if (import.meta.main) {
  exportAndroidIcons.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
