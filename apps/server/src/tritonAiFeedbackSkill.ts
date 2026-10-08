import { TRITONAI_FEEDBACK_SKILL_NAME } from "@t3tools/shared/tritonAiFeedback";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { resolveCodexHomeLayout } from "./provider/Drivers/CodexHomeLayout.ts";
import {
  discardProviderSkillInstallRollback,
  installSkillBundle,
} from "./provider/installProviderSkill.ts";
import { ServerSettingsService } from "./serverSettings.ts";

// raw.githubusercontent.com avoids the GitHub API's per-IP limit, which campus
// networks share across every Harness install behind the same address.
const SKILL_SOURCE_URL = `https://raw.githubusercontent.com/dbalders/UCSD-Skills-Library/main/tritonai/${TRITONAI_FEEDBACK_SKILL_NAME}`;
const SKILL_FILES = ["SKILL.md", "LICENSE"] as const;
const MAX_FILE_BYTES = 512 * 1024;
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
      Effect.flatMap((response) => response.text),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError(
        (cause) =>
          new TritonAiFeedbackSkillSyncError({ message: `Could not download ${url}.`, cause }),
      ),
      Effect.filterOrFail(
        (text) => text.length <= MAX_FILE_BYTES,
        () => new TritonAiFeedbackSkillSyncError({ message: `${url} is too large.` }),
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

export const syncLayer = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const fetchFile = fetchSkillFileWith(yield* HttpClient.HttpClient);
  const sync = Effect.gen(function* () {
    const effective = yield* settings.getSettings;
    const layout = yield* resolveCodexHomeLayout(effective.providers.codex);
    const path = yield* Path.Path;
    const result = yield* syncTritonAiFeedbackSkill({
      skillsDirectory: path.join(layout.sharedHomePath, "skills"),
      fetchFile,
    });
    if (result === "installed") {
      yield* Effect.logInfo(`Installed the latest ${TRITONAI_FEEDBACK_SKILL_NAME} skill.`);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`Could not sync the ${TRITONAI_FEEDBACK_SKILL_NAME} skill.`, { cause }),
    ),
  );
  yield* sync.pipe(Effect.repeat(Schedule.spaced(REFRESH_INTERVAL)), Effect.forkScoped);
});
