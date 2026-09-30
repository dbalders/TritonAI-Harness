import { describe, expect, it } from "vite-plus/test";
import { BUILT_IN_THEMES, getThemeColorsForAppearance } from "@t3tools/shared/themePalettes";

import { themeColorToNativeColor } from "../../lib/mobileTheme";

import { buildGhosttyThemeConfig, getMobileTerminalTheme } from "./terminalTheme";

describe("getMobileTerminalTheme", () => {
  it("applies the selected palette without replacing ANSI status colors", () => {
    const standard = getMobileTerminalTheme("t3-code", "dark");
    const ocean = getMobileTerminalTheme("ocean", "dark");

    expect(ocean.background).not.toBe(standard.background);
    expect(ocean.cursorForeground).not.toBe(standard.cursorForeground);
    expect(ocean.palette).toEqual(standard.palette);
  });

  it("uses the canonical desktop terminal roles for built-in themes", () => {
    const theme = BUILT_IN_THEMES.find((candidate) => candidate.id === "ocean")!;
    const colors = getThemeColorsForAppearance(theme, "dark")!;
    const terminal = getMobileTerminalTheme("ocean", "dark");

    expect(terminal.background).toBe(themeColorToNativeColor(colors.terminalBackground));
    expect(terminal.foreground).toBe(themeColorToNativeColor(colors.terminalForeground));
    expect(terminal.cursorForeground).toBe(themeColorToNativeColor(colors.terminalCursor));
  });
});

describe("buildGhosttyThemeConfig", () => {
  it("serializes theme colors into a ghostty config file", () => {
    const config = buildGhosttyThemeConfig({
      background: "#123456",
      foreground: "#abcdef",
      mutedForeground: "#777777",
      border: "#888888",
      cursorForeground: "#fedcba",
      cursorBackground: "#654321",
      palette: [
        "#000000",
        "#111111",
        "#222222",
        "#333333",
        "#444444",
        "#555555",
        "#666666",
        "#777777",
        "#888888",
        "#999999",
        "#aaaaaa",
        "#bbbbbb",
        "#cccccc",
        "#dddddd",
        "#eeeeee",
        "#ffffff",
      ],
    });

    expect(config).toContain("background = #123456");
    expect(config).toContain("foreground = #abcdef");
    expect(config).toContain("cursor-color = #fedcba");
    expect(config).toContain("cursor-text = #654321");
    expect(config).toContain("palette = 0=#000000");
    expect(config).toContain("palette = 15=#ffffff");
    expect(config.match(/^palette = /gm)).toHaveLength(16);
    expect(config.endsWith("\n")).toBe(true);
  });
});
