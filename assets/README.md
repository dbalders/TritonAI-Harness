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
an Icon Composer macOS rendition; Windows, Linux, favicons, and runtime logos get
rounded-square renditions. Desktop packaging converts the generated macOS PNGs into
ICNS resources. Edit the source layers rather than generated PNG/ICO renditions.

Development retains its separate Aurora circular raster master at
`dev/tritonai-harness-dev-1024.png`. Its desktop/web exports and opaque iOS layer
are generated from that master by the same export command.

## Android launcher and splash artwork

Run `vp run icons:export:android` after changing either release master. Main and
Preview use the same full-bleed source artwork for their adaptive backgrounds and
splash images. The release foreground is transparent so Android can apply its own
adaptive mask without framing a rounded-square icon twice. The monochrome and
notification icons use a white Triton silhouette extracted from the main master.

Development's existing Android blueprint assets are separate and remain checked in;
the release Android exporter does not regenerate them.
