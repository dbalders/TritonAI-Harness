import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarState } from "./sidebarState";

describe("resolveSidebarState", () => {
  it.each([
    [true, true, false, "collapsed"],
    [true, false, true, "expanded"],
    [false, true, false, "expanded"],
    [false, false, true, "collapsed"],
  ] as const)(
    "resolves mobile=%s, desktop open=%s, mobile open=%s to %s",
    (isMobile, open, openMobile, expected) => {
      expect(resolveSidebarState({ isMobile, open, openMobile })).toBe(expected);
    },
  );
});
