# TritonAI Harness nightly artwork

The nightly logo is a white Triton mark over a full-bleed square navy/indigo/violet
starry sky. It shares the main icon's geometry and fills the rounded-square Dock
and iOS silhouettes. Older upstream T3 artwork is retained as reference and is not
selected by the release asset mapping.

The source is `tritonai-app-icon.icon/Assets/logo.png`, created with the built-in
image generator by extending the approved circular artwork through all four corners.
The Icon Composer project uses this opaque layer without glass, shadow, or translucency.

`vp run icons:export` derives the macOS, Linux, Windows, web, and iOS renditions.
`vp run icons:export:android` derives the release Android adaptive/splash artwork.
`tritonai-harness-nightly-1024.png` is now a generated macOS rendition, rather than
the former circular raster master. Desktop packaging continues to convert it to
ICNS through the existing release path.
