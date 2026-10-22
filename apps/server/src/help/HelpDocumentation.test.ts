import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
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
const layerSource = HelpDocumentation.layer.pipe(Layer.provideMerge(NodeServices.layer));
const sourceGuide = (name: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.readFileString(
        NodeURL.fileURLToPath(new URL(`../../../../docs/user/${name}`, import.meta.url)),
      ),
    ),
  );

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
  it.effect("reserves complete cleanup instructions before filling higher-ranked guides", () =>
    Effect.gen(function* () {
      const source = yield* sourceGuide("project-settings.md");
      const cleanup = /^## Storage cleanup\n[\s\S]*?(?=\n## |$)/m.exec(source)![0].trim();
      const docs = yield* HelpDocumentation.HelpDocumentation;
      const result = yield* docs.search("How do I clean up old worktrees?");
      const settings = result.documentation.find(
        (doc) => doc.path === "docs/user/project-settings.md",
      );
      expect(settings?.content).toContain(cleanup);
      expect(
        result.documentation.reduce((size, doc) => size + doc.content.length, 0),
      ).toBeLessThanOrEqual(20_000);
      expect(isDocumentation(result.documentation)).toBe(true);
      expect(yield* docs.search("How do I clean up old worktrees?")).toEqual(result);
    }).pipe(Effect.provide(layerSource)),
  );

  it.effect(
    "uses recent topic context to retrieve computer-use permissions for an ambiguous follow-up",
    () =>
      Effect.gen(function* () {
        const docs = yield* HelpDocumentation.HelpDocumentation;
        const source = yield* sourceGuide("computer-use.md");
        for (const context of [
          "i saw someone have their app use a mouse for them, how do i do that",
          "Use Computer use in Settings > General to control the mouse.",
        ]) {
          const result = yield* docs.search("What permissions do I need?", context);
          expect(result.documentation[0]?.path).toBe("docs/user/computer-use.md");
          expect(result.documentation[0]?.content).toBe(source);
        }
      }).pipe(Effect.provide(layerSource)),
  );

  it.effect(
    "retrieves the actual complete computer-use instructions for a mouse question and follow-up",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const source = yield* fileSystem.readFileString(
          NodeURL.fileURLToPath(new URL("../../../../docs/user/computer-use.md", import.meta.url)),
        );
        const docs = yield* HelpDocumentation.HelpDocumentation;
        for (const question of [
          "i saw someone have their app use a mouse for them, how do i do that",
          "is that not computer use?",
        ]) {
          const result = yield* docs.search(question);
          expect(result.documentationStatus).toBe("available");
          const first = result.documentation[0];
          expect(first?.path).toBe("docs/user/computer-use.md");
          expect(first?.content).toBe(source);
          for (const instruction of [
            "Settings > General",
            "off by default",
            "Accessibility",
            "Screen Recording",
            "Restart Harness",
            "local desktop backend",
            "Codex provider",
            "/computer-use",
          ])
            expect(first?.content).toContain(instruction);
        }
      }).pipe(Effect.provide(layerSource)),
  );

  it.effect("discovers existing topics by title and body without a maintained topic list", () =>
    Effect.gen(function* () {
      const docs = yield* HelpDocumentation.HelpDocumentation;
      const examples = [
        ["How do I import browser sessions?", "browser-import.md"],
        ["How can I record a skill?", "record-a-skill.md"],
        ["Where can I change custom model prices?", "usage.md"],
        ["How can I set up webhook automations?", "project-settings.md"],
        ["How do I snooze a thread until later?", "thread-sidebar.md"],
        ["How do I connect through Tailscale HTTPS?", "remote-access.md"],
      ];
      for (const [question, file] of examples) {
        const result = yield* docs.search(question!);
        expect(result.documentation.map((doc) => doc.path)).toContain(`docs/user/${file}`);
      }
      expect(yield* docs.search("xyzzyunmatched")).toEqual({
        documentationStatus: "available",
        documentation: [],
      });
    }).pipe(Effect.provide(layerSource)),
  );

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

  it.effect("reports an unavailable source catalog on filesystem failure", () =>
    search("computer use").pipe(
      Effect.provide(HelpDocumentation.layer.pipe(Layer.provide(FileSystem.layerNoop({})))),
      Effect.map((result) =>
        expect(result).toEqual({ documentationStatus: "unavailable", documentation: [] }),
      ),
    ),
  );
});

describe("HelpDocumentation packaged catalog", () => {
  it.effect("budgets secondary matching sections before unrelated whole-guide text", () => {
    const setup = "## Mouse permissions setup\n\nEnable mouse control after checking permissions.";
    const permissions = `## Permissions\n\n${"Detailed access instructions. ".repeat(225)}\n\nKeep all permission instructions together.`;
    return search("mouse permissions").pipe(
      Effect.provide(
        withPackaged([
          {
            path: "docs/user/overview.md",
            content: `# Mouse permissions\n\nQuick overview.\n\n## Unrelated\n\n${"irrelevant ".repeat(1_400)}`,
          },
          {
            path: "docs/user/desktop.md",
            content: `# Desktop guide\n\n${setup}\n\n${permissions}`,
          },
        ]),
      ),
      Effect.map((result) => {
        const target = result.documentation.find((doc) => doc.path === "docs/user/desktop.md");
        expect(target?.content).toContain(setup);
        expect(target?.content).toContain(permissions);
        expect(
          result.documentation.find((doc) => doc.path === "docs/user/overview.md")?.content,
        ).not.toContain("irrelevant irrelevant");
        expect(
          result.documentation.reduce((size, doc) => size + doc.content.length, 0),
        ).toBeLessThanOrEqual(20_000);
        expect(isDocumentation(result.documentation)).toBe(true);
      }),
    );
  });

  it.effect("retains the cleanup tail of a long settings guide beside a competing long guide", () =>
    Effect.gen(function* () {
      const source = yield* sourceGuide("project-settings.md");
      const sidebar = yield* sourceGuide("thread-sidebar.md");
      const cleanup = /^## Storage cleanup\n[\s\S]*?(?=\n## |$)/m.exec(source)![0].trim();
      const result = yield* search("How do I clean up old worktrees?").pipe(
        Effect.provide(
          withPackaged([
            { path: "docs/user/thread-sidebar.md", content: sidebar },
            {
              path: "docs/user/project-settings.md",
              content: source.replace(
                "\n## Project briefs",
                `\n\n${"Unrelated introduction. ".repeat(1_000)}\n\n## Project briefs`,
              ),
            },
          ]),
        ),
      );
      const settings = result.documentation.find(
        (doc) => doc.path === "docs/user/project-settings.md",
      );
      expect(settings?.content).toContain(cleanup);
      expect(settings?.content).toContain("other sections are omitted");
      expect(settings?.content).not.toContain("Unrelated introduction.");
      expect(
        result.documentation.reduce((size, doc) => size + doc.content.length, 0),
      ).toBeLessThanOrEqual(20_000);
      expect(isDocumentation(result.documentation)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "uses embedded docs with no filesystem and resolves ranking ties by source path",
    () => {
      const layer = withPackaged([
        { path: "docs/user/zebra.md", content: "# Mouse\n\nLocal instructions." },
        { path: "docs/user/alpha.md", content: "# Mouse\n\nLocal instructions." },
      ]);
      return Effect.gen(function* () {
        const docs = yield* HelpDocumentation.HelpDocumentation;
        const first = yield* docs.search("mouse");
        expect(first.documentation.map((doc) => doc.path)).toEqual([
          "docs/user/alpha.md",
          "docs/user/zebra.md",
        ]);
        expect(yield* docs.search("mouse")).toEqual(first);
      }).pipe(Effect.provide(layer));
    },
  );

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

  it.effect("limits many matching short guides to eight documents", () =>
    search("new feature").pipe(
      Effect.provide(
        withPackaged(
          Array.from({ length: 12 }, (_, index) => ({
            path: `docs/user/feature-${index}.md`,
            content: `# New feature ${index}\n\nPublic guide.`,
          })),
        ),
      ),
      Effect.map((result) => expect(result.documentation).toHaveLength(8)),
    ),
  );
});
