import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import { injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";

type Node = DefaultTreeAdapterMap["node"];
type Parent = DefaultTreeAdapterMap["parentNode"];

// Arbitrary page JavaScript also has non-Fetch channels (notably WebRTC).
// Until a client supplies a verified network boundary, only our bootstrap runs.
const ELEMENTS = new Set(
  "html head body title style div span p br hr h1 h2 h3 h4 h5 h6 header footer main section article aside nav address blockquote pre code kbd samp var em strong b i u s small sub sup mark abbr time q cite del ins ul ol li dl dt dd table caption colgroup col thead tbody tfoot tr th td figure figcaption picture img a details summary dialog form fieldset legend label input textarea select option optgroup button output progress meter datalist wbr".split(
    " ",
  ),
);
const ATTRIBUTES = new Set(
  "id class style title lang dir role hidden tabindex open colspan rowspan span width height alt loading decoding type name value placeholder checked selected disabled readonly multiple min max step minlength maxlength rows cols size required autocomplete inputmode pattern for form aria-label aria-labelledby aria-describedby aria-expanded aria-hidden aria-controls aria-live aria-atomic aria-current scope datetime start reversed wrap spellcheck".split(
    " ",
  ),
);
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const RASTER_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon);base64,[a-z\d+/=\s]+$/i;

function sanitize(parent: Parent, depth = 0): void {
  if (depth > 128) {
    parent.childNodes = [];
    return;
  }
  parent.childNodes = parent.childNodes.filter((node: Node) => {
    if (!("tagName" in node)) return node.nodeName === "#text" || node.nodeName === "#documentType";
    if (node.namespaceURI !== HTML_NAMESPACE || !ELEMENTS.has(node.tagName)) return false;
    node.attrs = node.attrs.filter(({ name, value, namespace }) => {
      if (namespace !== undefined) return false;
      if (name === "href") return node.tagName === "a" && /^#[^\s]*$/.test(value);
      if (name === "src") return node.tagName === "img" && RASTER_IMAGE.test(value);
      return ATTRIBUTES.has(name);
    });
    sanitize(node, depth + 1);
    return true;
  });
}

export function offlineHtmlPreview(html: string): {
  readonly html: string;
  readonly headers: Readonly<Record<string, string>>;
} {
  const document = parse(html, { scriptingEnabled: false });
  sanitize(document);
  const nonce = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(24))).toString(
    "base64",
  );
  const preview = injectHtmlRenderBootstrap(serialize(document)).replace(
    "<script>",
    `<script nonce="${nonce}">`,
  );
  return {
    html: preview,
    headers: {
      "Content-Security-Policy": [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        "script-src-attr 'none'",
        "style-src 'unsafe-inline'",
        "img-src data:",
        "font-src data:",
        "media-src 'none'",
        "connect-src 'none'",
        "frame-src 'none'",
        "worker-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "sandbox allow-scripts",
      ].join("; "),
      "Referrer-Policy": "no-referrer",
      "X-DNS-Prefetch-Control": "off",
      "Cache-Control": "private, no-store",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    },
  };
}
