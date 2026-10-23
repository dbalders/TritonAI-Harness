// @effect-diagnostics nodeBuiltinImport:off - Vite loads this immutable public build input before server services exist.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Build inputs come only from the repository's public user guides, never runtime settings. */
export function loadHelpDocumentationForBuild(repoRoot: string) {
  const directory = NodePath.join(repoRoot, "docs/user");
  const catalog = NodeFS.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[a-z0-9][a-z0-9-]*\.md$/i.test(entry.name))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((entry) => ({
      path: `docs/user/${entry.name}`,
      content: NodeFS.readFileSync(NodePath.join(directory, entry.name), "utf8"),
    }));
  if (catalog.length === 0)
    throw new Error("Help requires public docs/user Markdown at build time.");
  // Reject a bad release input here rather than shipping a catalog the runtime cannot use.
  if (
    catalog.length > 512 ||
    catalog.reduce((size, doc) => size + doc.content.length, 0) > 2_000_000
  )
    throw new Error("Help documentation exceeds the public catalog budget.");
  for (const doc of catalog) {
    const title = /^#\s+(.+)$/m.exec(doc.content)?.[1]?.trim();
    if (!title || title.length > 300 || doc.path.length > 300 || doc.content.length > 256_000)
      throw new Error(`Help documentation has an invalid title, path or size: ${doc.path}.`);
  }
  return catalog;
}
