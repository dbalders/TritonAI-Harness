# Brand icons

The Icon Composer projects are the source of truth for the generated application icon families:

- `dev/app-icon.icon`
- `nightly/app-icon.icon`
- `prod/app-icon.icon`

TritonAI nightly releases use the starry night-sky family: the upstream night
gradient, stars, sparkles, and clouds, with the circular TritonAI mark in place
of the T3 wordmark. Production releases use the TritonAI production family.
The production macOS desktop icon is the full-size circular exception
documented below; until the nightly macOS export below is completed, the
nightly macOS desktop icon also uses that production circular mark.

Each project uses `logo.svg` for its TritonAI mark, except `dev/app-icon.icon`, which uses its own development artwork. Backgrounds use `background.svg` when the background is a vector layer. Additional layers use semantic names that describe their role and placement.

Run `vp run icons:export` from the repository root to regenerate the tracked iOS, Linux, Windows, and web assets. The development web exports are also copied to `apps/web/public` for the browser favicon and splash screen. Run `vp run icons:check` to verify that the generated assets and public copies match their sources without changing files.

Exporting requires Icon Composer 2 or newer on macOS. The script selects the newest compatible exporter from Xcode or a standalone Icon Composer installation and pins design generation 26. Set `ICON_COMPOSER_TOOL` to the full path of `Icon Composer.app/Contents/Executables/ictool` to override automatic discovery.

## macOS desktop assets

The export script intentionally leaves the tracked macOS PNGs unchanged. The production desktop icon uses the original full-size circular TritonAI mark on a transparent canvas; `prod/tritonai-harness-1024.png` is the source of truth for that treatment. The circle must touch all four canvas edges and the four corners must remain transparent. Do not replace it with an Icon Composer macOS export, which adds a rounded-square background and insets the mark.

After changing the development or nightly Icon Composer project, open it in Icon Composer and export its macOS PNG with exactly these settings:

- Platform: `macOS pre-Tahoe`
- Appearance: `Default`
- Size: `1024pt`
- Scale: `1×`

Save the development export to:

- `dev/app-icon.icon` -> `dev/tritonai-harness-dev-1024.png`

Save the nightly export to:

- `nightly/app-icon.icon` -> `nightly/nightly-macos-1024.png`

The tracked `nightly/nightly-macos-1024.png` still contains the upstream T3
artwork. Until the GUI export above replaces it,
`BRAND_ASSET_PATHS.nightlyMacIconPng` keeps selecting the production circular
mark; after exporting, update it to `assets/nightly/nightly-macos-1024.png`.

Each result must be a 1024×1024 PNG with the classic macOS safe area: the opaque icon body is 824×824, inset 100 pixels on every side, with only the native Icon Composer shadow extending into the surrounding transparent canvas.

To have Codex perform the native exports, paste this prompt into a task opened at the repository root:

```text
Use [@Computer](plugin://computer-use@openai-bundled) and the Icon Composer app to export the development and nightly macOS app icons in this repository.

For each project below, use Platform: macOS pre-Tahoe, Appearance: Default, Size: 1024pt, and Scale: 1×, then save the PNG to the exact destination:

- assets/dev/app-icon.icon -> assets/dev/tritonai-harness-dev-1024.png
- assets/nightly/app-icon.icon -> assets/nightly/nightly-macos-1024.png

Do not resize, composite, or otherwise post-process the exported PNGs.

Verify every result is 1024×1024 and has the classic macOS safe area: an 824×824 opaque body inset 100px on every side, with only Icon Composer's native shadow extending beyond it.
```

Do not edit the generated iOS, universal, web, or ICO files directly.

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
