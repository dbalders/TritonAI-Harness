import * as NodeURL from "node:url";
import type { HelpKnowledge } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

declare const __TRITONAI_HELP_DOCUMENTATION__: unknown;

const catalogSchema = Schema.Array(
  Schema.Struct({
    path: Schema.String.check(Schema.isPattern(/^docs\/user\/[a-z0-9][a-z0-9-]*\.md$/i)),
    content: Schema.String.check(Schema.isMaxLength(256_000)),
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(512));
const decodeCatalog = Schema.decodeUnknownEffect(catalogSchema);
const MAX_DOCUMENT = 16_000;
const MAX_SELECTED = 20_000;
const MAX_CATALOG = 2_000_000;

export class HelpDocumentation extends Context.Service<
  HelpDocumentation,
  {
    readonly search: (
      question: string,
      recentContext?: string,
    ) => Effect.Effect<Pick<HelpKnowledge, "documentationStatus" | "documentation">>;
  }
>()("t3/help/HelpDocumentation") {}

// General question words carry no topic information. Feature vocabulary lives in the docs.
const stopWords = new Set(
  "a an and are as at be been but by can could did do does for from get had has have help how i if in into is it its me my not of on or our saw should someone some that the their them then there these they this to use using was we were what when where which who why will with would you your app harness tritonai".split(
    " ",
  ),
);
const words = (text: string): ReadonlySet<string> =>
  new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
      (word) => word.length > 1 && !stopWords.has(word),
    ),
  );
const wordCounts = (text: string): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (word.length > 1 && !stopWords.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
};
const comparePath = (left: { path: string }, right: { path: string }) =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

/** Keep headings inside code fences in their original section. Never cut an instruction mid-block. */
function sections(content: string): string[] {
  const result: string[] = [];
  let current: string[] = [];
  let fence: string | undefined;
  for (const line of content.split("\n")) {
    const delimiter = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence && /^#{1,6} /.test(line) && current.length > 0) {
      result.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = undefined;
    }
  }
  if (current.length > 0) result.push(current.join("\n").trim());
  return result.filter(Boolean);
}

function excerpt(
  doc: { path: string; content: string; sections: readonly string[] },
  selected: readonly number[],
): string {
  if (selected.length === doc.sections.length) return doc.content;
  const label = `> Excerpt from ${doc.path}. Only complete sections are included; other sections are omitted.\n\n`;
  return (
    label +
    [...selected]
      .sort((a, b) => a - b)
      .map((index) => doc.sections[index])
      .join("\n\n")
  );
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const readSourceCatalog = Effect.gen(function* () {
    // This exact source location is the only fallback. A bundle without its define cannot
    // search cwd, a project, the app data directory, or a path supplied by a Help question.
    if (!import.meta.url.endsWith("/apps/server/src/help/HelpDocumentation.ts")) return null;
    const directory = NodeURL.fileURLToPath(new URL("../../../../docs/user/", import.meta.url));
    const canonicalDirectory = yield* fileSystem.realPath(directory);
    if (canonicalDirectory !== directory.replace(/[\\/]$/, "")) return null;
    const names = (yield* fileSystem.readDirectory(directory))
      .filter((name) => /^[a-z0-9][a-z0-9-]*\.md$/i.test(name))
      .sort();
    if (names.length > 512) return null;
    const catalog: { path: string; content: string }[] = [];
    let total = 0;
    for (const name of names) {
      const absolute = NodeURL.fileURLToPath(
        new URL(name, new URL("../../../../docs/user/", import.meta.url)),
      );
      // Symlinked docs and directories are not a way to expand this public-data boundary.
      if ((yield* fileSystem.realPath(absolute)) !== absolute) continue;
      const info = yield* fileSystem.stat(absolute);
      if (info.type !== "File" || info.size > 256_000) continue;
      const content = yield* fileSystem.readFileString(absolute);
      total += content.length;
      if (total > MAX_CATALOG) return null;
      catalog.push({ path: `docs/user/${name}`, content });
    }
    return catalog;
  });
  const catalog = yield* (
    typeof __TRITONAI_HELP_DOCUMENTATION__ === "undefined"
      ? readSourceCatalog
      : Effect.succeed(__TRITONAI_HELP_DOCUMENTATION__)
  ).pipe(
    Effect.flatMap(decodeCatalog),
    Effect.orElseSucceed(() => null),
  );
  const usable =
    catalog !== null &&
    catalog.reduce((size, doc) => size + doc.content.length, 0) <= MAX_CATALOG &&
    new Set(catalog.map((doc) => doc.path)).size === catalog.length;
  const indexed = usable
    ? catalog.flatMap((doc) => {
        const title = /^#\s+(.+)$/m.exec(doc.content)?.[1]?.trim();
        if (!title || title.length > 300 || doc.path.length > 300 || !doc.content.trim()) return [];
        const parts = sections(doc.content);
        const aliases = [...doc.content.matchAll(/<!--\s*help-search:\s*([\s\S]*?)-->/g)]
          .map((match) => match[1])
          .join(" ");
        return [
          {
            ...doc,
            title,
            sections: parts,
            sectionWordCounts: parts.map(wordCounts),
            sectionHeadingWords: parts.map((content) => words(content.split("\n")[0]!)),
            titleWords: words(`${title} ${doc.path}`),
            aliasWords: words(aliases),
            headingWords: words(parts.map((part) => part.split("\n")[0]).join(" ")),
            contentWords: words(doc.content),
          },
        ];
      })
    : [];

  const search: HelpDocumentation["Service"]["search"] = Effect.fn("HelpDocumentation.search")(
    (question, recentContext = "") =>
      Effect.sync(() => {
        const documentation: HelpKnowledge["documentation"][number][] = [];
        if (indexed.length === 0)
          return { documentationStatus: "unavailable" as const, documentation };
        const currentTerms = [...words(question.slice(0, 8_000))].slice(0, 80);
        // Context is local retrieval input only, never copied into the public snapshot.
        // The final question retains priority over a small recent conversation window.
        const contextTerms = [...words(recentContext.slice(0, 2_001))].slice(0, 40);
        const terms = [...new Set([...currentTerms, ...contextTerms])];
        const current = new Set(currentTerms);
        const weights = new Map(
          terms.map((term) => {
            const frequency = indexed.filter((entry) => entry.contentWords.has(term)).length;
            return [
              term,
              (current.has(term) ? 1 : 0.5) *
                (1 + Math.log((indexed.length + 1) / (frequency + 1))),
            ];
          }),
        );
        const ranked = indexed
          .map((doc) => ({
            doc,
            score: terms.reduce((score, term) => {
              const weight = weights.get(term)!;
              return (
                score +
                weight *
                  (Number(doc.titleWords.has(term)) * 6 +
                    Number(doc.aliasWords.has(term)) * 5 +
                    Number(doc.headingWords.has(term)) * 3 +
                    Number(doc.contentWords.has(term)))
              );
            }, 0),
          }))
          .filter((entry) => entry.score > 0)
          .sort((left, right) => right.score - left.score || comparePath(left.doc, right.doc));
        let remaining = MAX_SELECTED;
        const selected: {
          doc: (typeof indexed)[number];
          indices: number[];
          sections: { index: number; score: number }[];
          content: string;
        }[] = [];
        // Reserve relevant complete sections across guides before spending spare space
        // on whole guides. A high-ranked long guide must not starve another topic's steps.
        for (const { doc } of ranked) {
          if (selected.length === 8 || remaining <= 0) break;
          const sections = doc.sections
            .map((content, index) => ({
              index,
              score: terms.reduce((score, term) => {
                const occurrences = doc.sectionWordCounts[index]!.get(term) ?? 0;
                if (occurrences === 0) return score;
                // Repeated topic words distinguish a complete procedure from a passing mention.
                return (
                  score +
                  weights.get(term)! *
                    (1 +
                      Math.log(occurrences) +
                      Number(doc.sectionHeadingWords[index]!.has(term)) * 3)
                );
              }, 0),
            }))
            .filter((section) => section.score > 0)
            .sort((left, right) => right.score - left.score || left.index - right.index);
          // Preserve a compact primary guide before broad prerequisite matches
          // consume the budget. Long guides still reserve only relevant sections,
          // leaving at least half the budget for instructions from other topics.
          if (selected.length === 0 && doc.content.length <= MAX_SELECTED / 2) {
            selected.push({
              doc,
              indices: doc.sections.map((_, index) => index),
              sections,
              content: doc.content,
            });
            remaining -= doc.content.length;
            continue;
          }
          for (const section of sections) {
            const content = excerpt(doc, [section.index]);
            if (content.length > Math.min(MAX_DOCUMENT, remaining)) continue;
            selected.push({ doc, indices: [section.index], sections, content });
            remaining -= content.length;
            break;
          }
        }
        // Secondary matching sections also take precedence over unrelated guide text.
        for (const entry of selected) {
          for (const section of entry.sections) {
            if (entry.indices.includes(section.index)) continue;
            const indices = [...entry.indices, section.index];
            const content = excerpt(entry.doc, indices);
            const extra = content.length - entry.content.length;
            if (content.length > MAX_DOCUMENT || extra > remaining) continue;
            entry.indices = indices;
            entry.content = content;
            remaining -= extra;
          }
        }
        for (const entry of selected) {
          const extra = entry.doc.content.length - entry.content.length;
          if (entry.doc.content.length <= MAX_DOCUMENT && extra <= remaining) {
            entry.content = entry.doc.content;
            remaining -= extra;
          }
          documentation.push({
            title: entry.doc.title,
            path: entry.doc.path,
            content: entry.content,
          });
        }
        return { documentationStatus: "available" as const, documentation };
      }),
  );
  return HelpDocumentation.of({ search });
});

export const layer = Layer.effect(HelpDocumentation, make);
