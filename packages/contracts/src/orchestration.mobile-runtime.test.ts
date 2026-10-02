import { afterEach, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("loads the mobile contracts and decodes project icons without Intl.Segmenter", async () => {
  vi.stubGlobal("Intl", Object.create(Intl, { Segmenter: { value: undefined } }));
  vi.resetModules();

  const { ProjectIconOverride } = await import("./index.ts");
  const decode = Schema.decodeUnknownSync(ProjectIconOverride);
  for (const monogram of ["T3", "e\u0301", "किखि", "क्ष", "क्\u200dष"]) {
    const icon = { kind: "lucide", name: "folder-code", color: "blue", monogram };
    expect(decode(icon)).toEqual(icon);
  }
  for (const monogram of ["ABC", "किखिगि", "e\u0301e\u0301e\u0301"]) {
    expect(() =>
      decode({ kind: "lucide", name: "folder-code", color: "blue", monogram }),
    ).toThrow();
  }
});
