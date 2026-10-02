import { describe, expect, it } from "vite-plus/test";

import { isLegalDocumentUrl } from "./legal-document-url";

describe("isLegalDocumentUrl", () => {
  it.each([
    "https://tritonai.ucsd.edu/about/trust-architecture.html",
    "https://tritonai.ucsd.edu/about/trust-architecture.html/",
    "https://tritonai.ucsd.edu/about/trust-architecture.html?source=app",
    "https://ucsd.edu/about/terms-of-use.html#updates",
  ])("allows a configured legal document: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(true);
  });

  it.each([
    "https://t3.codes/download",
    "https://t3.codes/privacy-policy",
    "https://tritonai.ucsd.edu/developer-apis/harness.html",
    "https://ucsd.edu/about/terms-of-use.html.evil",
    "https://example.com/legal",
    "javascript:alert(1)",
    "not-a-url",
  ])("rejects a URL outside the legal-document allowlist: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(false);
  });
});
