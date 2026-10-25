// @effect-diagnostics nodeBuiltinImport:off - expectations mirror the host path joins the script under test performs.

import { SHOWCASE_ENVIRONMENTS } from "./mobile-showcase-environment.ts";
import { SHOWCASE_PROJECTS } from "./mobile-showcase-environment.ts";
import { SHOWCASE_THREADS } from "./mobile-showcase-environment.ts";

import { assert, it } from "@effect/vitest";

import { PNG } from "pngjs";

import {
  encodeAndroidPairingUrls,
  normalizeStorePng,
  parsePairingCredentialOutput,
  readPngMetadata,
} from "./mobile-showcase.ts";

function rgbaPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(255);
  return PNG.sync.write(png);
}

it("converts simulator RGBA captures to upload-safe 24-bit RGB PNGs", () => {
  const normalized = normalizeStorePng(rgbaPng(2, 3));
  assert.deepStrictEqual(readPngMetadata(normalized), {
    width: 2,
    height: 3,
    bitDepth: 8,
    colorType: 2,
    hasAlpha: false,
  });
});

it("seeds a playful multi-environment project spectrum", () => {
  assert.deepStrictEqual(
    SHOWCASE_PROJECTS.map((project) => project.title),
    ["T3 Code", "React", "Linux"],
  );
  assert.deepStrictEqual(
    SHOWCASE_ENVIRONMENTS.map((environment) => environment.label),
    ["Moonbase Terminal", "Suspense Station", "Kernel Cabin"],
  );
  assert.equal(SHOWCASE_THREADS.length, 9);
  assert.equal(new Set(SHOWCASE_THREADS.map((thread) => thread.projectId)).size, 3);
  assert.match(SHOWCASE_THREADS[0]?.request ?? "", /TritonAI Harness/u);
  assert.match(SHOWCASE_THREADS[0]?.response ?? "", /TritonAI Harness/u);
  assert.equal((SHOWCASE_THREADS[0]?.request ?? "").includes("Give T3 Code"), false);
  // Every project contributes to both the active block and the settled tail,
  // so each list scope screenshots with the same two-part structure.
  for (const project of SHOWCASE_PROJECTS) {
    const projectThreads = SHOWCASE_THREADS.filter((thread) => thread.projectId === project.id);
    assert.equal(
      projectThreads.some((thread) => "settled" in thread && thread.settled),
      true,
      `${project.title} has no settled thread`,
    );
    assert.equal(
      projectThreads.some((thread) => !("settled" in thread && thread.settled)),
      true,
      `${project.title} has no active thread`,
    );
  }
  assert.equal(
    SHOWCASE_PROJECTS.every((project) => project.favicon.includes("<svg")),
    true,
  );
});

it("reads multiline JSON from the pairing CLI", () => {
  assert.equal(
    parsePairingCredentialOutput('server log\n{\n  "credential": "PAIR-ME"\n}\n'),
    "PAIR-ME",
  );
});

it("encodes Android pairing URLs without shell-sensitive JSON quotes", () => {
  const urls = ["http://10.0.2.2:65164/#token=ONE", "http://10.0.2.2:65198/#token=TWO"];
  const encoded = encodeAndroidPairingUrls(urls);
  assert.equal(encoded.startsWith("json-uri:"), true);
  assert.deepStrictEqual(JSON.parse(decodeURIComponent(encoded.slice("json-uri:".length))), urls);
  assert.equal(encoded.includes('"'), false);
});
