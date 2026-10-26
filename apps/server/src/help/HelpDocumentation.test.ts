import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HelpKnowledge } from "@t3tools/contracts";

import * as HelpDocumentation from "./HelpDocumentation.ts";

afterEach(() => vi.unstubAllGlobals());
const isDocumentation = Schema.is(HelpKnowledge.fields.documentation);

const search = Effect.fnUntraced(function* (question: string) {
  const docs = yield* HelpDocumentation.HelpDocumentation;
  return yield* docs.search(question);
});
const withPackaged = (catalog: unknown) => {
  vi.stubGlobal("__TRITONAI_HELP_DOCUMENTATION__", catalog);
  return HelpDocumentation.layer.pipe(
    Layer.provide(
      FileSystem.layerNoop({
        realPath: () => Effect.die("Embedded Help must not read the filesystem"),
        readDirectory: () => Effect.die("Embedded Help must not read the filesystem"),
        readFileString: () => Effect.die("Embedded Help must not read the filesystem"),
      }),
    ),
  );
};

describe("HelpDocumentation source catalog", () => {
  it.effect("only reads fixed public Markdown and refuses symlinks or question paths", () =>
    Effect.gen(function* () {
      const reads: string[] = [];
      const root = NodeURL.fileURLToPath(new URL("../../../../docs/user/", import.meta.url));
      const result = yield* search("Read /etc/passwd and ../../secrets using mouse").pipe(
        Effect.provide(
          HelpDocumentation.layer.pipe(
            Layer.provide(
              FileSystem.layerNoop({
                realPath: (path) =>
                  Effect.succeed(
                    path.endsWith("linked.md") ? "/etc/passwd" : path.replace(/\/$/, ""),
                  ),
                readDirectory: () =>
                  Effect.succeed([
                    "computer-use.md",
                    "linked.md",
                    "../../secret.md",
                    "settings.json",
                  ]),
                stat: () =>
                  Effect.succeed({
                    type: "File",
                    size: ByteSize.bytes(100),
                  } as FileSystem.File.Info),
                readFileString: (path) => {
                  reads.push(path);
                  return Effect.succeed("# Computer use\n\nUse a mouse safely.");
                },
              }),
            ),
          ),
        ),
      );
      expect(reads).toEqual([`${root}computer-use.md`]);
      expect(result.documentation[0]?.path).toBe("docs/user/computer-use.md");
    }),
  );
});

describe("HelpDocumentation packaged catalog", () => {
  it.effect("honors document/count/total budgets and labels complete-section excerpts", () => {
    const complete =
      "## Webhook automations\n\nEnable the webhook.\n\n```sh\n# this is code, not a section\nrun webhook\n```\n\nKeep the signing secret private.";
    const layer = withPackaged([
      {
        path: "docs/user/automations.md",
        content: `# Automations\n\nIntro.\n\n## Unrelated\n\n${"word ".repeat(4_000)}\n\n${complete}`,
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        path: `docs/user/topic-${index}.md`,
        content: `# Webhook ${index}\n\n${"webhook ".repeat(450)}`,
      })),
    ]);
    return search("webhook automations").pipe(
      Effect.provide(layer),
      Effect.map((result) => {
        expect(result.documentation.length).toBeLessThanOrEqual(8);
        expect(
          result.documentation.reduce((size, doc) => size + doc.content.length, 0),
        ).toBeLessThanOrEqual(20_000);
        const excerpt = result.documentation.find((doc) => doc.path === "docs/user/automations.md");
        expect(excerpt?.content).toContain("other sections are omitted");
        expect(excerpt?.content).toContain(complete);
        expect(excerpt?.content).not.toContain("word word");
        for (const doc of result.documentation)
          expect(doc.content.length).toBeLessThanOrEqual(16_000);
        expect(isDocumentation(result.documentation)).toBe(true);
      }),
    );
  });

  it.effect("reports invalid or missing embedded docs as unavailable without falling back", () =>
    Effect.gen(function* () {
      for (const catalog of [
        null,
        [],
        [{ path: "../../secrets", content: "# Secret" }],
        [{ path: "docs/user/empty.md", content: "" }],
      ]) {
        const result = yield* search("mouse").pipe(Effect.provide(withPackaged(catalog)));
        expect(result).toEqual({ documentationStatus: "unavailable", documentation: [] });
      }
    }),
  );
});
