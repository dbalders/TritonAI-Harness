/**
 * scratchThreadFolder - gives a thread without a project its own folder.
 *
 * Each Scratch ("No project") thread gets a folder under the Scratch root,
 * named from its date, first words, and id. It rides in worktreePath like any
 * thread that runs outside its project root, so the provider, terminal, and
 * file tree all use it.
 *
 * @module scratchThreadFolder
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** The Scratch root under a server's base directory. */
export function scratchWorkspaceRootFor(path: Path.Path, baseDir: string): string {
  return path.resolve(baseDir, "scratch");
}

/**
 * Creates and returns the thread's folder. Only [a-z0-9] reaches the name, so
 * it stays one path segment inside the scratch root, and the words are capped
 * so pasted data cannot outgrow a file name. Each leaf is created without
 * `recursive`, so the create itself claims it: a taken short name falls back
 * to the full id, which only the same thread can already hold.
 */
export const claimScratchThreadFolder = Effect.fn("ScratchThreadFolder.claim")(function* (
  scratchRoot: string,
  input: { readonly threadId: string; readonly createdAt: string; readonly text: string },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const words = input.text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 5)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "");
  const id = input.threadId.toLowerCase().replace(/[^a-z0-9]/g, "");
  const folderFor = (idPart: string) =>
    path.join(scratchRoot, [input.createdAt.slice(0, 10), words, idPart].filter(Boolean).join("-"));
  yield* fileSystem.makeDirectory(scratchRoot, { recursive: true });
  const claim = (folder: string) =>
    fileSystem.makeDirectory(folder).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.succeed(false),
      ),
    );
  const shortFolder = folderFor(id.slice(0, 8));
  if (yield* claim(shortFolder)) return shortFolder;
  const fullFolder = folderFor(id);
  yield* claim(fullFolder);
  return fullFolder;
});
