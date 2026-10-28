import * as NodeURL from "node:url";
import * as HtmlPreview from "./HtmlPreview.ts";

export const layer = HtmlPreview.layerWithCommand({
  command: process.execPath,
  args: [NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)), "__html-preview"],
});
