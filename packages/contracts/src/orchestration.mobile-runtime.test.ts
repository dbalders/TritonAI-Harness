import { afterEach, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// regression: 3445a3b6fd fix(contracts): preserve Unicode monograms across runtimes
it("rejects more than two visible letters separated by joiners without Intl.Segmenter", async () => {
  vi.stubGlobal("Intl", Object.create(Intl, { Segmenter: { value: undefined } }));
  vi.resetModules();

  const { ProjectIconOverride } = await import("./index.ts");
  const decode = Schema.decodeUnknownSync(ProjectIconOverride);
  for (const monogram of ["A\u200dB\u200dC", "A\u200cB\u200cC"]) {
    expect(() => decode({ kind: "monogram", text: monogram, color: "blue" })).toThrow();
  }
});

// regression: 3445a3b6fd fix(contracts): preserve Unicode monograms across runtimes
it("decodes persisted international monograms without Intl.Segmenter", async () => {
  vi.stubGlobal("Intl", Object.create(Intl, { Segmenter: { value: undefined } }));
  vi.resetModules();

  const { StoredProjectIcon } = await import("./index.ts");
  const decode = Schema.decodeUnknownSync(StoredProjectIcon);
  for (const monogram of ["क्षत्र", "한국".normalize("NFD"), "กำขำ", "ກຳຂຳ"]) {
    const icon = { kind: "lucide", name: "folder-code", color: "blue", monogram };
    expect(decode(icon)).toEqual({ kind: "monogram", text: monogram, color: "blue" });
  }
});

it("loads the mobile contracts and decodes project icons without Intl.Segmenter", async () => {
  vi.stubGlobal("Intl", Object.create(Intl, { Segmenter: { value: undefined } }));
  vi.resetModules();

  const { ReceivedProjectIcon } = await import("./index.ts");
  const decode = Schema.decodeUnknownSync(ReceivedProjectIcon);
  for (const monogram of ["T3", "e\u0301", "किखि", "क्ष", "क्\u200dष"]) {
    const icon = { kind: "lucide", name: "folder-code", color: "blue", monogram };
    expect(decode(icon)).toEqual({ kind: "monogram", text: monogram, color: "blue" });
  }
  for (const monogram of ["ABC", "किखिगि", "e\u0301e\u0301e\u0301"]) {
    expect(() =>
      decode({ kind: "lucide", name: "folder-code", color: "blue", monogram }),
    ).toThrow();
  }
});
