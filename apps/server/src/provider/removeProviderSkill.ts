// @effect-diagnostics nodeBuiltinImport:off - lstat device/inode checks bind destructive work to the inspected managed directory.
import * as NodeFS from "node:fs";

import {
  type ServerProvider,
  ServerProviderSkillRemovalError,
  type ServerRemoveProviderSkillInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

export interface ProviderSkillRemovalTarget {
  readonly skillDirectoryPath: string;
  readonly sharedSkillsDirectory?: string;
  readonly expectedIdentity?: ProviderSkillRemovalIdentity | null;
}

export interface ProviderSkillRemovalIdentity {
  readonly sharedSkillsDirectory: PathIdentity;
  readonly skillDirectory: PathIdentity;
}

interface PathIdentity {
  readonly dev: number;
  readonly ino: number;
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
): Effect.Effect<boolean, PlatformError.PlatformError> {
  return fileSystem.readLink(targetPath).pipe(
    Effect.as(true),
    Effect.catchTags({
      PlatformError: (cause) => {
        const nodeCause = cause.reason.cause;
        const isRegularPath =
          cause.reason._tag === "Unknown" &&
          typeof nodeCause === "object" &&
          nodeCause !== null &&
          "code" in nodeCause &&
          nodeCause.code === "EINVAL";
        return cause.reason._tag === "NotFound" || isRegularPath
          ? Effect.succeed(false)
          : Effect.fail(cause);
      },
    }),
  );
}

const pathIdentity = ({ dev, ino }: NodeFS.Stats): PathIdentity => ({ dev, ino });

const samePathIdentity = (left: PathIdentity, right: PathIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const pathEntryExists = (
  targetPath: string,
): Effect.Effect<boolean, ServerProviderSkillRemovalError> =>
  Effect.try({
    try: () => {
      try {
        NodeFS.lstatSync(targetPath);
        return true;
      } catch (cause) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        ) {
          return false;
        }
        throw cause;
      }
    },
    catch: (cause) => removalError(`Failed to inspect skill folder '${targetPath}'.`, cause),
  });

const inspectProviderSkillRemovalIdentity = (
  sharedSkillsDirectory: string,
  skillDirectoryPath: string,
  message: string,
): Effect.Effect<ProviderSkillRemovalIdentity, ServerProviderSkillRemovalError> =>
  Effect.try({
    try: () => {
      const sharedBefore = NodeFS.lstatSync(sharedSkillsDirectory);
      const skill = NodeFS.lstatSync(skillDirectoryPath);
      const sharedAfter = NodeFS.lstatSync(sharedSkillsDirectory);
      if (
        !sharedBefore.isDirectory() ||
        !skill.isDirectory() ||
        !sharedAfter.isDirectory() ||
        !samePathIdentity(pathIdentity(sharedBefore), pathIdentity(sharedAfter))
      ) {
        throw new Error(
          "The managed skills directory or skill identity changed during inspection.",
        );
      }
      return {
        sharedSkillsDirectory: pathIdentity(sharedAfter),
        skillDirectory: pathIdentity(skill),
      };
    },
    catch: (cause) => removalError(message, cause),
  });

const verifyProviderSkillRemovalIdentity = (
  sharedSkillsDirectory: string,
  skillDirectoryPath: string,
  expected: ProviderSkillRemovalIdentity,
): Effect.Effect<void, ServerProviderSkillRemovalError> =>
  inspectProviderSkillRemovalIdentity(
    sharedSkillsDirectory,
    skillDirectoryPath,
    `Failed to verify skill folder '${skillDirectoryPath}' during removal.`,
  ).pipe(
    Effect.mapError((cause) =>
      removalError(
        `Refusing to remove skill folder '${skillDirectoryPath}' after it changed during removal.`,
        cause,
      ),
    ),
    Effect.flatMap((current) =>
      samePathIdentity(current.sharedSkillsDirectory, expected.sharedSkillsDirectory) &&
      samePathIdentity(current.skillDirectory, expected.skillDirectory)
        ? Effect.void
        : removalError(
            `Refusing to remove skill folder '${skillDirectoryPath}' after it changed during removal.`,
          ),
    ),
  );

export const providerSkillRemovalIdentityMatches = (
  sharedSkillsDirectory: string,
  skillDirectoryPath: string,
  expected: ProviderSkillRemovalIdentity,
): Effect.Effect<boolean> =>
  inspectProviderSkillRemovalIdentity(
    sharedSkillsDirectory,
    skillDirectoryPath,
    `Failed to inspect skill folder '${skillDirectoryPath}' after removal failed.`,
  ).pipe(
    Effect.map(
      (current) =>
        samePathIdentity(current.sharedSkillsDirectory, expected.sharedSkillsDirectory) &&
        samePathIdentity(current.skillDirectory, expected.skillDirectory),
    ),
    Effect.orElseSucceed(() => false),
  );

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
  const inspectSymbolicLink = (targetPath: string) =>
    isSymbolicLinkPath(fileSystem, targetPath).pipe(
      Effect.mapError((cause) =>
        removalError(`Failed to inspect skill removal path ${targetPath}.`, cause),
      ),
    );
  if (
    (yield* inspectSymbolicLink(sharedSkillsDirectory)) ||
    (yield* inspectSymbolicLink(skillDirectoryPath))
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
  if (realSkillDirectory === null) return null;

  return yield* inspectProviderSkillRemovalIdentity(
    sharedSkillsDirectory,
    skillDirectoryPath,
    `Failed to capture skill removal identity for ${skillDirectoryPath}.`,
  );
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
    const path = yield* Path.Path;
    const sharedSkillsDirectory = path.resolve(
      target.sharedSkillsDirectory ?? path.dirname(target.skillDirectoryPath),
    );
    const skillDirectoryPath = path.resolve(target.skillDirectoryPath);
    if (path.dirname(skillDirectoryPath) !== sharedSkillsDirectory) {
      return yield* removalError(
        "Only skills installed directly in TritonAI's managed Codex skills folder can be removed.",
      );
    }
    const skillExists = yield* pathEntryExists(skillDirectoryPath);
    if (!skillExists) return;
    if (target.expectedIdentity === null) {
      return yield* removalError(
        `Refusing to remove skill folder '${skillDirectoryPath}' because it appeared after removal began.`,
      );
    }

    const expectedIdentity =
      target.expectedIdentity ??
      (yield* inspectProviderSkillRemovalIdentity(
        sharedSkillsDirectory,
        skillDirectoryPath,
        `Failed to capture skill removal identity for ${skillDirectoryPath}.`,
      ));
    yield* verifyProviderSkillRemovalIdentity(
      sharedSkillsDirectory,
      skillDirectoryPath,
      expectedIdentity,
    );

    const quarantineRoot = yield* fileSystem
      .makeTempDirectory({
        directory: sharedSkillsDirectory,
        prefix: `.${path.basename(skillDirectoryPath)}.remove.`,
      })
      .pipe(
        Effect.mapError((cause) =>
          removalError(`Failed to prepare removal of '${skillDirectoryPath}'.`, cause),
        ),
      );
    const quarantinedSkillPath = path.join(quarantineRoot, "skill");
    let preserveQuarantine = false;
    yield* Effect.gen(function* () {
      yield* verifyProviderSkillRemovalIdentity(
        sharedSkillsDirectory,
        skillDirectoryPath,
        expectedIdentity,
      );
      const moved = yield* fileSystem.rename(skillDirectoryPath, quarantinedSkillPath).pipe(
        Effect.as(true),
        Effect.catchIf(
          (cause) => cause.reason._tag === "NotFound",
          () => Effect.succeed(false),
        ),
        Effect.mapError((cause) =>
          removalError(`Failed to quarantine skill folder '${skillDirectoryPath}'.`, cause),
        ),
      );
      if (!moved) return;
      preserveQuarantine = true;
      yield* verifyProviderSkillRemovalIdentity(
        sharedSkillsDirectory,
        quarantinedSkillPath,
        expectedIdentity,
      );

      if (
        yield* isSymbolicLinkPath(fileSystem, quarantinedSkillPath).pipe(
          Effect.mapError((cause) =>
            removalError(`Failed to inspect quarantined skill '${skillDirectoryPath}'.`, cause),
          ),
        )
      ) {
        const removedSymlink = yield* fileSystem.remove(quarantinedSkillPath).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (removedSymlink) preserveQuarantine = false;
        return yield* removalError(
          `Refusing to remove skill folder '${skillDirectoryPath}' after it changed during removal.`,
        );
      }
      yield* fileSystem
        .remove(quarantinedSkillPath, { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            removalError(
              `Failed to remove skill folder '${skillDirectoryPath}'. Recovery data may remain at '${quarantinedSkillPath}'.`,
              cause,
            ),
          ),
        );
      preserveQuarantine = false;
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          preserveQuarantine
            ? Effect.void
            : fileSystem
                .remove(quarantineRoot, { recursive: true, force: true })
                .pipe(Effect.ignore),
        ),
      ),
    );
  });
}
