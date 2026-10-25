import { isRedirect } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";
import { Route } from "./settings.usage";

describe("legacy settings usage route", () => {
  // regression: 663a67370e fix(usage): consolidate TritonAI reporting
  it("replaces old bookmarks with the canonical usage page", async () => {
    let thrown: unknown;

    try {
      await Route.options.beforeLoad?.({} as never);
    } catch (error) {
      thrown = error;
    }

    expect(isRedirect(thrown)).toBe(true);
    if (!isRedirect(thrown)) return;
    expect(thrown.options).toMatchObject({ to: "/usage", replace: true });
  });
});
