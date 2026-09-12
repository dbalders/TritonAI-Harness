# TritonAI Harness nightly artwork

The approved nightly logo keeps the white TritonAI trident on a navy/indigo/violet starry sky,
matching the default Nightly sidebar palette. Stable blue and development assets are separate.
The older upstream T3 files in this directory are retained as upstream reference and are not
selected by TritonAI's nightly asset mapping.

## Source and exports

- `tritonai-harness-nightly-1024.png`: approved raster master, 1024 square, genuinely transparent exterior.
- `tritonai-app-icon.icon`: Icon Composer source for mobile, with an opaque dark fill beneath the badge.
- `tritonai-harness-nightly-universal-1024.png`: transparent desktop/Linux copy.
- `tritonai-harness-nightly-ios-1024.png` and Apple touch rendition: opaque dark exterior for Apple surfaces.
- Windows ICO and favicons: generated from the master with area filtering in premultiplied alpha.

`scripts/lib/nightly-icon-export.ts` produces the smaller exports from the approved master;
`scripts/export-brand-icons.ts` uses it for nightly, so future icon exports do not restore the
stable blue or upstream T3 logo. The nightly export test checks the checked-in bytes and real
transparency. Desktop packaging converts the PNG to macOS icon resources through its existing path.

## Generation

Created with the built-in image generator. The user accepted the generated trident geometry
and explicitly authorized fixing the background with repository image tooling after the image
generator baked a checkerboard into both attempts. The final asset was normalized to 1024px and
clipped with an antialiased circle slightly inside the contaminated edge; no checkerboard pixels
remain around the badge. The transparent master was visually inspected after correction.

Final generation prompt:

> Precise production asset edit. Correct image 1 for use as a real app icon. Its checkerboard is incorrectly baked into opaque pixels. REMOVE ALL CHECKERBOARD OUTSIDE THE CIRCULAR LOGO; those exterior pixels must be genuinely TRANSPARENT with PNG alpha=0, not a checkerboard illustration or white background. Produce a square 1024 by 1024 PNG. Preserve the circle's navy-purple starry background exactly. Use image 2 as the exact geometry reference for the white trident and circular outline: retain that SAME white mark, same widths, node sizes, proportions and bottom cropping. Do not redesign anything, don't add a border, text, or shadow. The only changes from image 1 should be true exterior alpha transparency, standardized 1024x1024 size, and matching the original trident geometry in image 2. This must be a real transparent cutout app icon.

Image 1 was the initial generated starry variant. Image 2 was
`assets/prod/tritonai-harness-1024.png`. The initial generation used the upstream nightly icon
only as a palette/style reference, excluding its T3 text, rounded-square shape, and bevel.
