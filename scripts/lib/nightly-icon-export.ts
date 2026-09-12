import { PNG } from "pngjs";
import { BRAND_ASSET_PATHS } from "./brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./icon-export.ts";

// Area-average premultiplied pixels so tiny favicon edges retain transparency
// without dragging the transparent exterior's RGB into the visible badge.
export function resizeNightlyIcon(source: PNG, size: number, opaque = false): Buffer {
  const output = new PNG({ width: size, height: size });
  const scale = source.width / size;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const left = x * scale,
        top = y * scale,
        right = (x + 1) * scale,
        bottom = (y + 1) * scale;
      const rgba = [0, 0, 0, 0];
      for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++) {
        for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
          const weight =
            (Math.min(sx + 1, right) - Math.max(sx, left)) *
            (Math.min(sy + 1, bottom) - Math.max(sy, top));
          const index = (sy * source.width + sx) * 4;
          const alpha = source.data[index + 3]! / 255;
          rgba[3]! += alpha * weight;
          for (let c = 0; c < 3; c++) rgba[c]! += source.data[index + c]! * alpha * weight;
        }
      }
      const area = scale * scale,
        alpha = rgba[3]! / area;
      const index = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        output.data[index + c] = Math.round(
          opaque
            ? rgba[c]! / area + [8, 13, 34][c]! * (1 - alpha)
            : rgba[3]! > 0
              ? rgba[c]! / rgba[3]!
              : 0,
        );
      }
      output.data[index + 3] = opaque ? 255 : Math.round(alpha * 255);
    }
  return PNG.sync.write(output);
}

export function renderNightlyIconAssets(master: Buffer): Map<string, Buffer> {
  const source = PNG.sync.read(master);
  if (source.width !== 1024 || source.height !== 1024)
    throw new Error("Nightly icon master must be 1024x1024.");
  const ico = encodePngIco(
    WINDOWS_ICON_SIZES.map((size) => ({ size, contents: resizeNightlyIcon(source, size) })),
  );
  return new Map([
    [BRAND_ASSET_PATHS.nightlyIosIconPng, resizeNightlyIcon(source, 1024, true)],
    [BRAND_ASSET_PATHS.nightlyLinuxIconPng, master],
    [BRAND_ASSET_PATHS.nightlyWindowsIconIco, ico],
    [BRAND_ASSET_PATHS.nightlyWebFaviconIco, ico],
    [BRAND_ASSET_PATHS.nightlyWebFavicon16Png, resizeNightlyIcon(source, 16)],
    [BRAND_ASSET_PATHS.nightlyWebFavicon32Png, resizeNightlyIcon(source, 32)],
    [BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng, resizeNightlyIcon(source, 180, true)],
  ]);
}
