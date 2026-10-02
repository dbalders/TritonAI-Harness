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
the central two thirds of a 288dp canvas. The Android artwork is exported from the approved
Harness production, development, and nightly PNG masters by `vp run icons:export:android`:

- `apps/mobile/assets/android-icon-foreground*.png`: variant badges sized to stay inside the
  adaptive safe zone. Each uses its configured solid background color.
- `apps/mobile/assets/android-splash-icon-*.png`: badges on the matching background, sized for
  the splash mask.

Rerun the export after changing a master. `android-icon-mark.png`, `android-notification-icon.png`,
and the native agent notification drawable derive a white trident silhouette from the production
master for Android's system-tinted icons.
