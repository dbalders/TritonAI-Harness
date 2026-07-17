import {
  type ServerProvider,
  ServerProviderSkillRemovalError,
  type ServerRemoveProviderSkillInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export interface ProviderSkillRemovalTarget {
  readonly skillDirectoryPath: string;
}

function removalError(message: string, cause?: unknown) {
  return new ServerProviderSkillRemovalError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function isSymbolicLinkPath(
  fileSystem: FileSystem.FileSystem,
  targetPath: string,
): Effect.Effect<boolean> {
  return fileSystem.readLink(targetPath).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
}

export const ensureProviderSkillRemovalPathIsSafe = Effect.fn(
  "ensureProviderSkillRemovalPathIsSafe",
)(function* (input: {
  readonly sharedSkillsDirectory: string;
  readonly skillDirectoryPath: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sharedSkillsDirectory = path.resolve(input.sharedSkillsDirectory);
  const skillDirectoryPath = path.resolve(input.skillDirectoryPath);
  const outsideManagedSkillsError = () =>
    removalError(
      "Only skills installed into TritonAI's managed Codex skills folder can be removed.",
    );

  if (path.dirname(skillDirectoryPath) !== sharedSkillsDirectory) {
    return yield* outsideManagedSkillsError();
  }
  if (
    (yield* isSymbolicLinkPath(fileSystem, sharedSkillsDirectory)) ||
    (yield* isSymbolicLinkPath(fileSystem, skillDirectoryPath))
  ) {
    return yield* outsideManagedSkillsError();
  }

  const realSharedSkills = yield* fileSystem
    .realPath(sharedSkillsDirectory)
    .pipe(
      Effect.mapError((cause) =>
        removalError(`Failed to verify Codex skills folder ${sharedSkillsDirectory}.`, cause),
      ),
    );
  const realSkillDirectory = yield* fileSystem.realPath(skillDirectoryPath).pipe(
    Effect.catchIf(
      (cause) => cause.reason._tag === "NotFound",
      () => Effect.succeed(null),
    ),
    Effect.mapError((cause) =>
      removalError(`Failed to verify skill folder ${skillDirectoryPath}.`, cause),
    ),
  );
  if (realSkillDirectory !== null && path.dirname(realSkillDirectory) !== realSharedSkills) {
    return yield* outsideManagedSkillsError();
  }
});

export function resolveProviderSkillRemovalTarget(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly request: ServerRemoveProviderSkillInput;
}): Effect.Effect<ProviderSkillRemovalTarget, ServerProviderSkillRemovalError, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const provider = input.providers.find(
      (candidate) => candidate.instanceId === input.request.instanceId,
    );
    if (!provider) {
      return yield* removalError(`Provider '${input.request.instanceId}' was not found.`);
    }

    const skill = provider.skills.find((candidate) => candidate.path === input.request.skillPath);
    if (!skill) {
      return yield* removalError("Skill was not found in the current provider inventory.");
    }

    if (!path.isAbsolute(skill.path)) {
      return yield* removalError("Skill path must be absolute before it can be removed.");
    }

    if (path.basename(skill.path) !== "SKILL.md") {
      return yield* removalError("Only SKILL.md-backed skill folders can be removed.");
    }

    const skillDirectoryPath = path.dirname(skill.path);
    if (!skillDirectoryPath || skillDirectoryPath === path.parse(skillDirectoryPath).root) {
      return yield* removalError("Refusing to remove an unsafe skill directory.");
    }
    if (path.basename(path.dirname(skillDirectoryPath)) !== "skills") {
      return yield* removalError("Skill folder must live directly under a skills directory.");
    }

    return { skillDirectoryPath };
  });
}

export function removeProviderSkillFolder(
  target: ProviderSkillRemovalTarget,
): Effect.Effect<void, ServerProviderSkillRemovalError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem
      .remove(target.skillDirectoryPath, { recursive: true, force: true })
      .pipe(
        Effect.mapError((cause) =>
          removalError(`Failed to remove skill folder '${target.skillDirectoryPath}'.`, cause),
        ),
      );
  });
}
