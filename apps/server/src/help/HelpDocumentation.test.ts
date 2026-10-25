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
  it.effect(
    "uses recent topic context to retrieve computer-use permissions for an ambiguous follow-up",
    () =>
      Effect.gen(function* () {
        const docs = yield* HelpDocumentation.HelpDocumentation;
        const source = yield* sourceGuide("computer-use.md");
        for (const context of [
          "i saw someone have their app use a mouse for them, how do i do that",
          "Use Computer use in Settings > General to control the mouse.",
          // A real answer mentions several prerequisites and other features. Those
          // matches must not crowd the primary guide out of the retrieval budget.
          "That's Computer use—it lets the agent move the mouse, click, type, and interact with desktop apps.\n\nOn your Mac, it's currently off, but Accessibility and Screen Recording permissions are already granted.\n\nOpen Settings → General → Computer use and turn it on.\nIf prompted, choose Restart Harness, then check that the status is Ready.\nIn a normal chat using a Codex-backed provider, try: /computer-use Open Notes and create a note.\n\nIt works only with the local desktop backend, not SSH, WSL, or other remote environments. I can explain setup here, but can't control your mouse from Help.\ni saw someone have their app use a mouse for them, how do i do that",
        ]) {
          const result = yield* docs.search("What permissions do I need?", context);
          expect(result.documentation[0]?.path).toBe("docs/user/computer-use.md");
          expect(result.documentation[0]?.content).toBe(source);
        }
      }).pipe(Effect.provide(layerSource)),
  );

  it.effect("discovers existing topics by title and body without a maintained topic list", () =>
    Effect.gen(function* () {
      const docs = yield* HelpDocumentation.HelpDocumentation;
      const examples = [
        ["How can I record a skill?", "record-a-skill.md"],
        ["Where can I change custom model prices?", "usage.md"],
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
