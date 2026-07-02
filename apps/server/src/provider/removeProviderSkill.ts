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
    yield* fileSystem.remove(target.skillDirectoryPath, { recursive: true }).pipe(
      Effect.mapError((cause) =>
        removalError(`Failed to remove skill folder '${target.skillDirectoryPath}'.`, cause),
      ),
    );
  });
}
