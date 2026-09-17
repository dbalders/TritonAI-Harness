# Brand icons

Production uses `prod/app-icon.icon` as its Icon Composer source. Development and nightly
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
The production macOS PNG remains the original full-size circular TritonAI mark.

Do not edit generated PNG/ICO renditions directly; update the appropriate master.

## Android adaptive foreground

`apps/mobile/assets/android-icon-foreground.svg` is the source of truth for the foreground used by
the normal Android adaptive launcher icon. Export its paired PNG after changing it:

```sh
rsvg-convert -w 432 -h 432 \
  -o apps/mobile/assets/android-icon-foreground.png \
  apps/mobile/assets/android-icon-foreground.svg
```

The foreground must remain transparent and keep the T3 mark inside Android's adaptive-icon safe
zone. `android-icon-mark.png` remains a flat silhouette for Android's monochrome themed icon.
