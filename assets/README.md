# Brand icons

Production uses `prod/app-icon.icon` for its generated iOS, Linux, Windows, and web assets.
The separate production macOS master is `prod/tritonai-harness-1024.png`;
`icons:export` intentionally leaves it unchanged. Development and nightly
use approved circular raster masters:

- `dev/tritonai-harness-dev-1024.png` — Aurora: white trident over navy and teal waves.
- `nightly/tritonai-harness-nightly-1024.png` — white trident over the starry purple sky.

Run `vp run icons:export` to regenerate PNG/ICO renditions and the development web
favicon/splash copies. Run `vp run icons:check` to verify the exports.
Development and nightly retain the circular transparent silhouette for macOS and Linux;
iOS and Apple touch icons are flattened onto navy. Development's Icon Composer layer
is generated from the same master for iOS builds. Do not replace the development
master with the old pre-Tahoe rounded-square export.

Production exporting requires Icon Composer 2 or newer on macOS. The exporter pins
design generation 26. `ICON_COMPOSER_TOOL` can select a specific `ictool` executable.
The production macOS master must remain the original full-size circular TritonAI mark
with transparent corners. Do not replace it with an inset Icon Composer macOS export.

Do not edit generated PNG/ICO renditions directly; update the appropriate master.

## Android launcher and splash artwork

Android masks the central 72dp of a 108dp adaptive canvas, and the Android 12+ splash screen masks
the central two thirds of a 288dp canvas, so the Icon Composer exports cannot be used directly:
their rounded-square silhouette gets framed again and the wordmark is cropped. The Android artwork
is instead rendered from the same Icon Composer SVG sources by `vp run icons:export:android`:

- `apps/mobile/assets/android-icon-foreground.png`: the shared transparent wordmark, sized to stay
  inside the safe zone
- `apps/mobile/assets/android-icon-background-dev.png` and `-nightly.png`: full-bleed variant
  artwork (blueprint grid and annotations; night sky and clouds). Production uses a solid color.
- `apps/mobile/assets/android-splash-icon-*.png`: the two layers composed into one 288dp image, so
  the splash mask reproduces the launcher icon's framing.

Rerun the export after changing a layer SVG. `android-icon-mark.png` remains a flat silhouette for
Android's monochrome themed icon.
