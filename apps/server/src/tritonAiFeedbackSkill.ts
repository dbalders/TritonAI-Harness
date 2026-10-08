import { TRITONAI_FEEDBACK_SKILL_NAME } from "@t3tools/shared/tritonAiFeedback";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { resolveCodexHomeLayout } from "./provider/Drivers/CodexHomeLayout.ts";
import {
  discardProviderSkillInstallRollback,
  extractFrontmatter,
  installSkillBundle,
  readLimitedInstallText,
} from "./provider/installProviderSkill.ts";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import { ServerSettingsService } from "./serverSettings.ts";

// raw.githubusercontent.com avoids the GitHub API's per-IP limit, which campus
// networks share across every Harness install behind the same address.
const SKILL_SOURCE_URL = `https://raw.githubusercontent.com/dbalders/UCSD-Skills-Library/main/tritonai/${TRITONAI_FEEDBACK_SKILL_NAME}`;
const SKILL_FILES = ["SKILL.md", "LICENSE"] as const;
const REQUEST_TIMEOUT = Duration.seconds(15);
const REFRESH_INTERVAL = Duration.hours(6);

export class TritonAiFeedbackSkillSyncError extends Schema.TaggedError<TritonAiFeedbackSkillSyncError>()(
  "TritonAiFeedbackSkillSyncError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export type FetchSkillFile = (url: string) => Effect.Effect<string, TritonAiFeedbackSkillSyncError>;

const fetchSkillFileWith =
  (client: HttpClient.HttpClient): FetchSkillFile =>
  (url) =>
    client.get(url).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => readLimitedInstallText(url, response)),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError(
        (cause) =>
          new TritonAiFeedbackSkillSyncError({ message: `Could not download ${url}.`, cause }),
      ),
    );

/**
 * Installs or refreshes the `tritonai-feedback` skill that `/feedback` runs.
 * The skill is maintained in UCSD-Skills-Library; every Harness keeps a copy so
 * `/feedback` works without a visit to the skills catalog.
 */
export const syncTritonAiFeedbackSkill = Effect.fn("syncTritonAiFeedbackSkill")(function* (input: {
  readonly skillsDirectory: string;
  readonly fetchFile: FetchSkillFile;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = yield* Effect.forEach(SKILL_FILES, (file) =>
    input
      .fetchFile(`${SKILL_SOURCE_URL}/${file}`)
      .pipe(Effect.map((content) => ({ path: file, content }))),
  );

  // The installer files a skill under its frontmatter name, so a renamed source
  // would land somewhere `/feedback` does not look.
  const { name } = yield* extractFrontmatter(files[0].content);
  if (name !== TRITONAI_FEEDBACK_SKILL_NAME) {
    return yield* new TritonAiFeedbackSkillSyncError({
      message: `The ${TRITONAI_FEEDBACK_SKILL_NAME} source is named '${name}'.`,
    });
  }

  const skillDirectory = path.join(input.skillsDirectory, TRITONAI_FEEDBACK_SKILL_NAME);
  const current = yield* Effect.forEach(files, (file) =>
    fs.readFileString(path.join(skillDirectory, file.path)).pipe(
      Effect.map((content) => content === file.content),
      Effect.orElseSucceed(() => false),
    ),
  );
  if (current.every(Boolean)) return "current" as const;

  const installed = yield* installSkillBundle({
    bundle: { version: 1, skillId: TRITONAI_FEEDBACK_SKILL_NAME, files },
    skillsDirectory: input.skillsDirectory,
  });
  yield* discardProviderSkillInstallRollback(installed.rollback).pipe(Effect.ignore);
  return "installed" as const;
});

/**
 * Keeps the skill current in the Codex home: on a schedule, and as soon as the
 * Codex home moves, so `/feedback` never waits a full interval in a new home.
 */
export const runTritonAiFeedbackSkillSync = Effect.fn("runTritonAiFeedbackSkillSync")(
  function* (input: {
    readonly currentSkillsDirectory: Effect.Effect<string>;
    readonly skillsDirectoryChanges: Stream.Stream<string>;
    readonly sync: (skillsDirectory: string) => Effect.Effect<void>;
    readonly refreshInterval: Duration.Input;
  }) {
    const lock = yield* Semaphore.make(1);
    const lastSynced = yield* Ref.make<string | null>(null);
    const syncInto = (skillsDirectory: string, force: boolean) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (!force && (yield* Ref.get(lastSynced)) === skillsDirectory) return;
          yield* Ref.set(lastSynced, skillsDirectory);
          yield* input.sync(skillsDirectory);
        }),
      );
    yield* input.currentSkillsDirectory.pipe(
      Effect.flatMap((skillsDirectory) => syncInto(skillsDirectory, true)),
      Effect.repeat(Schedule.spaced(input.refreshInterval)),
      Effect.forkScoped,
    );
    yield* input.skillsDirectoryChanges.pipe(
      Stream.runForEach((skillsDirectory) => syncInto(skillsDirectory, false)),
      Effect.forkScoped,
    );
  },
);

export const syncLayer = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const fetchFile = fetchSkillFileWith(yield* HttpClient.HttpClient);
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const path = yield* Path.Path;
  const skillsDirectoryFor = (effective: ServerSettings) =>
    resolveCodexHomeLayout(effective.providers.codex).pipe(
      Effect.map((layout) => path.join(layout.sharedHomePath, "skills")),
      Effect.provide(services),
    );
  const logFailure = (cause: Cause.Cause<unknown>) =>
    Effect.logWarning(`Could not sync the ${TRITONAI_FEEDBACK_SKILL_NAME} skill.`, { cause });
  yield* runTritonAiFeedbackSkillSync({
    // An unreadable settings file falls back to the default Codex home.
    currentSkillsDirectory: settings.getSettings.pipe(
      Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
      Effect.flatMap(skillsDirectoryFor),
    ),
    skillsDirectoryChanges: settings.streamChanges.pipe(Stream.mapEffect(skillsDirectoryFor)),
    refreshInterval: REFRESH_INTERVAL,
    sync: (skillsDirectory) =>
      syncTritonAiFeedbackSkill({ skillsDirectory, fetchFile }).pipe(
        Effect.flatMap((result) =>
          result === "installed"
            ? Effect.logInfo(`Installed the latest ${TRITONAI_FEEDBACK_SKILL_NAME} skill.`)
            : Effect.void,
        ),
        Effect.catchCause(logFailure),
        Effect.provide(services),
      ),
  });
});
