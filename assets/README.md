# Brand icons

Main and nightly share a full-bleed square icon family: a white Triton mark on navy
for main, and a starry blue/purple sky for nightly. Their authoritative 1024px masters
are the `Assets/logo.png` layers in these Icon Composer projects:

- `prod/app-icon.icon`
- `nightly/tritonai-app-icon.icon`

Run `vp run icons:export` to regenerate desktop, iOS, Windows, Linux, web, and runtime
logo assets. Run `vp run icons:check` to verify those exports. Icon Composer 2 or newer
on macOS is required; `ICON_COMPOSER_TOOL` can select an `ictool` executable. The
exporter pins design generation 26.

iOS receives the opaque square master and applies its own corner mask. macOS gets
an Icon Composer macOS rendition with 860px artwork centered on the 1024px canvas
to match neighboring Dock tiles in the desktop app; Windows, Linux, favicons, and runtime logos get
rounded-square renditions. Desktop packaging converts the generated macOS PNGs into
ICNS resources. Edit the source layers rather than generated PNG/ICO renditions.

Development retains its separate Aurora circular raster master at
`dev/tritonai-harness-dev-1024.png`. Its web, Linux, Windows, and opaque iOS exports
are generated from that unchanged master. The macOS-only project
`dev/macos-app-icon.icon` preserves the same Aurora artwork and extends its background
into the square corners. It generates `dev/tritonai-harness-dev-macos-1024.png` with
the same rounded-square shape and 860px Dock footprint as main and nightly.

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
