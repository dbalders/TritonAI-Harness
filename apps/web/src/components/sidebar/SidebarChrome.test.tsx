import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SidebarBrandIdentity } from "./SidebarChrome";

describe("SidebarBrandIdentity", () => {
  it("renders the compact TritonAI identity without a logo", () => {
    const markup = renderToStaticMarkup(<SidebarBrandIdentity onBackdrop={false} />);

    expect(markup).toContain("TritonAI");
    expect(markup).not.toContain("TritonAI Harness");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("tritonai-logo.png");
    expect(markup).not.toContain('aria-label="T3"');
  });
});
