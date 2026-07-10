import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SplashScreen } from "./SplashScreen";

describe("SplashScreen", () => {
  it("uses the production runtime logo instead of an environment app icon", () => {
    const markup = renderToStaticMarkup(<SplashScreen />);

    expect(markup).toContain('src="/tritonai-logo.png"');
    expect(markup).not.toContain("apple-touch-icon.png");
    expect(markup).not.toContain("tritonai-harness-dev");
  });
});
