import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SidebarBrandIdentity } from "./SidebarChrome";

describe("SidebarBrandIdentity", () => {
  it("renders the TritonAI Harness identity instead of the upstream T3 wordmark", () => {
    const markup = renderToStaticMarkup(<SidebarBrandIdentity onBackdrop={false} />);

    expect(markup).toContain('src="/tritonai-logo.png"');
    expect(markup).toContain("TritonAI Harness");
    expect(markup).not.toContain('aria-label="T3"');
  });
});
