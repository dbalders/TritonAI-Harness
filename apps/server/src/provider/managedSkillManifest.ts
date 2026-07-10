import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const MANIFEST_FILE_NAME = ".tritonai-managed-skills.json";
const MAX_MANIFEST_BYTES = 64 * 1024;
const SAFE_SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const EMPTY_MANAGED_SKILL_NAMES: ReadonlyArray<string> = [];

const ManagedSkillManifest = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("tritonai-secure"),
  skills: Schema.Array(Schema.String),
});
const decodeManagedSkillManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ManagedSkillManifest),
);

export interface ManagedSkillManifestResult {
  readonly skillNames: ReadonlyArray<string>;
  readonly status: "absent" | "invalid" | "unknown" | "valid";
  readonly warning?: string;
}

export function managedSkillManifestBlocksMutation(
  status: ManagedSkillManifestResult["status"],
): boolean {
  return status === "invalid" || status === "unknown";
}

export const loadManagedSkillManifest = Effect.fn("loadManagedSkillManifest")(function* (
  skillsDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(skillsDirectory, MANIFEST_FILE_NAME);
  const exists = yield* fs.exists(manifestPath).pipe(Effect.result);
  if (exists._tag === "Failure") {
    return {
      skillNames: EMPTY_MANAGED_SKILL_NAMES,
      status: "unknown",
      warning: "The managed secure skills manifest could not be inspected.",
    } satisfies ManagedSkillManifestResult;
  }
  if (!exists.success) {
    return {
      skillNames: EMPTY_MANAGED_SKILL_NAMES,
      status: "absent",
    } satisfies ManagedSkillManifestResult;
  }

  const isLink = yield* fs.readLink(manifestPath).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  const info = yield* fs.stat(manifestPath).pipe(Effect.result);
  if (info._tag === "Failure") {
    return {
      skillNames: EMPTY_MANAGED_SKILL_NAMES,
      status: "unknown",
      warning: "The managed secure skills manifest could not be inspected.",
    } satisfies ManagedSkillManifestResult;
  }
  if (isLink || info.success.type !== "File" || info.success.size > MAX_MANIFEST_BYTES) {
    return {
      skillNames: EMPTY_MANAGED_SKILL_NAMES,
      status: "invalid",
      warning: "The managed secure skills manifest is unsafe or too large.",
    } satisfies ManagedSkillManifestResult;
  }

  const content = yield* fs.readFileString(manifestPath).pipe(Effect.result);
  if (content._tag === "Failure") {
    return {
      skillNames: EMPTY_MANAGED_SKILL_NAMES,
      status: "unknown",
      warning: "The managed secure skills manifest could not be read.",
    } satisfies ManagedSkillManifestResult;
  }
  if (Buffer.byteLength(content.success) > MAX_MANIFEST_BYTES) {
    return {
      skillNames: EMPTY_MANAGED_SKILL_NAMES,
      status: "invalid",
      warning: "The managed secure skills manifest is too large.",
    } satisfies ManagedSkillManifestResult;
  }
  const decoded = yield* decodeManagedSkillManifest(content.success).pipe(Effect.result);
  if (decoded._tag === "Failure") {
    return {
      skillNames: EMPTY_MANAGED_SKILL_NAMES,
      status: "invalid",
      warning: "The managed secure skills manifest is invalid.",
    } satisfies ManagedSkillManifestResult;
  }

  const names = decoded.success.skills.map((name) => name.trim());
  if (names.some((name) => !SAFE_SKILL_NAME_PATTERN.test(name))) {
    return {
      skillNames: EMPTY_MANAGED_SKILL_NAMES,
      status: "invalid",
      warning: "The managed secure skills manifest contains an invalid skill name.",
    } satisfies ManagedSkillManifestResult;
  }
  return {
    skillNames: [...new Set(names)].toSorted((left, right) => left.localeCompare(right)),
    status: "valid",
  } satisfies ManagedSkillManifestResult;
});
