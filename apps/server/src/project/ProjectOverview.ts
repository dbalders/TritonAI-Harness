// @effect-diagnostics nodeBuiltinImport:off -- Cache identity is a deterministic content digest.
import * as NodeCrypto from "node:crypto";
import {
  ProjectOverview as Overview,
  ProjectOverviewError,
  type ProjectOverviewEnsureInput,
  type ProjectOverviewGetInput,
  type ProjectOverviewSnapshot,
  type ProjectOverviewSource,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as DailyMemory from "../memory/DailyMemory.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(encodeJson(value)).digest("hex");
const unavailable = () =>
  new ProjectOverviewError({ message: "Could not read or save this project's next steps." });
const decodeOverview = Schema.decodeUnknownEffect(Overview);
const decodeStored = Schema.decodeUnknownEffect(Schema.fromJsonString(Overview));
const encodeStored = Schema.encodeSync(Schema.fromJsonString(Overview));

interface Run {
  state: "generating" | "idle" | "error";
  digest: string;
  attemptedAt: number;
  contextAvailable: boolean;
  message: string | null;
  fiber?: Fiber.Fiber<void, never>;
}

export class ProjectOverview extends Context.Service<
  ProjectOverview,
  {
    readonly get: (
      input: ProjectOverviewGetInput,
    ) => Effect.Effect<ProjectOverviewSnapshot, ProjectOverviewError>;
    readonly subscribe: (
      input: ProjectOverviewGetInput,
    ) => Stream.Stream<ProjectOverviewSnapshot, ProjectOverviewError>;
    /** Checks the current project context, joining an existing run or reusing an unchanged cache. */
    readonly ensure: (
      input: ProjectOverviewEnsureInput,
    ) => Effect.Effect<ProjectOverviewSnapshot, ProjectOverviewError>;
    readonly awaitIdle: (projectId: ProjectId) => Effect.Effect<void>;
  }
>()("t3/project/ProjectOverview") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const memory = yield* DailyMemory.DailyMemory;
  const settings = yield* ServerSettings.ServerSettingsService;
  const generation = yield* TextGeneration.TextGeneration;
  const config = yield* ServerConfig.ServerConfig;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const scope = yield* Effect.scope;
  const locks = yield* KeyedLock.make<ProjectId>();
  const changes = yield* PubSub.sliding<ProjectId>(32);
  const runs = new Map<ProjectId, Run>();

  const projectFor = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ title: string; workspaceRoot: string }>`
        SELECT title, workspace_root AS "workspaceRoot" FROM projection_projects
        WHERE project_id=${projectId} AND deleted_at IS NULL
      `.pipe(Effect.mapError(unavailable));
      if (!rows[0])
        return yield* new ProjectOverviewError({ message: "This project is no longer available." });
      return rows[0];
    });

  const stored = (projectId: ProjectId, workspaceRoot: string) =>
    Effect.gen(function* () {
      // Deleted/archived threads cannot remain visible through the cached source excerpts.
      const rows = yield* sql<{ overview: string }>`
        SELECT overview_json AS overview FROM project_overviews o
        WHERE project_id=${projectId} AND workspace_root=${workspaceRoot}
        AND NOT EXISTS (
          SELECT 1 FROM json_each(o.overview_json, '$.sources') source
          WHERE json_extract(source.value, '$.threadId') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM harness_activity_threads t
            WHERE t.thread_id=json_extract(source.value, '$.threadId')
              AND t.project_id=${projectId} AND t.deleted_at IS NULL AND t.archived_at IS NULL
          )
        )
      `.pipe(Effect.mapError(unavailable));
      return rows[0]
        ? yield* decodeStored(rows[0].overview).pipe(Effect.mapError(unavailable))
        : null;
    });

  const get = Effect.fn("ProjectOverview.get")(function* (input: ProjectOverviewGetInput) {
    const project = yield* projectFor(input.projectId);
    const overview = yield* stored(input.projectId, project.workspaceRoot);
    const run = runs.get(input.projectId);
    return {
      projectId: input.projectId,
      overview,
      contextAvailable: run?.contextAvailable ?? overview !== null,
      generation: { state: run?.state ?? "idle", message: run?.message ?? null },
    } satisfies ProjectOverviewSnapshot;
  });

  const collect = Effect.fn("ProjectOverview.collect")(function* (projectId: ProjectId) {
    const project = yield* projectFor(projectId);
    const rows = yield* sql<{
      threadId: string;
      title: string;
      userId: string | null;
      userText: string | null;
      assistantId: string | null;
      assistantText: string | null;
    }>`
      WITH recent AS (
        SELECT t.thread_id, t.title FROM harness_activity_threads t
        WHERE t.project_id=${projectId} AND t.deleted_at IS NULL AND t.archived_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_threads v
            WHERE v.thread_id=t.thread_id
              AND json_extract(v.payload_json, '$.lineage.relationshipToParent')='subagent'
          )
        ORDER BY t.updated_at DESC, t.thread_id LIMIT 20
      )
      SELECT t.thread_id AS "threadId", t.title,
        u.message_id AS "userId", substr(u.text,1,1200) AS "userText",
        a.message_id AS "assistantId", substr(a.text,1,2000) AS "assistantText"
      FROM recent t
      LEFT JOIN harness_activity_messages u ON u.message_id=(
        SELECT message_id FROM harness_activity_messages m WHERE m.thread_id=t.thread_id
          AND m.role='user' AND m.is_streaming=0 AND trim(m.text)<>''
        ORDER BY m.created_at DESC,m.message_id DESC LIMIT 1
      )
      LEFT JOIN harness_activity_messages a ON a.message_id=(
        SELECT message_id FROM harness_activity_messages m WHERE m.thread_id=t.thread_id
          AND m.role='assistant' AND m.is_streaming=0 AND trim(m.text)<>''
        ORDER BY m.created_at DESC,m.message_id DESC LIMIT 1
      )
      ORDER BY t.thread_id
    `.pipe(Effect.mapError(unavailable));
    const projectMemory = yield* memory
      .getProjectMemory({ projectId })
      .pipe(Effect.mapError(unavailable));
    const sources: ProjectOverviewSource[] = rows
      .filter((row) => row.userText || row.assistantText)
      .map((row) => ({
        ref: `thread:${row.threadId}`,
        title: row.title.slice(0, 300) || "Project thread",
        threadId: ThreadId.make(row.threadId),
        text: [
          row.userText ? `User request:\n${row.userText}` : "",
          row.assistantText
            ? `Agent's own report (not owner acceptance):\n${row.assistantText}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      }));
    if (projectMemory.markdown?.trim()) {
      sources.push({
        ref: "note:project-memory",
        title: "Project history",
        threadId: null,
        text: projectMemory.markdown.slice(-4_000),
      });
    }
    const preferences = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
    const modelSelection = preferences.textGenerationModelSelection;
    return {
      project,
      sources,
      modelSelection,
      digest: digest({ project, sources, modelSelection }),
      context: encodeJson({
        project: { id: projectId, title: project.title },
        sources,
      }),
    };
  });

  const ensure = Effect.fn("ProjectOverview.ensure")(function* (input: ProjectOverviewEnsureInput) {
    return yield* locks.withLock(
      input.projectId,
      Effect.gen(function* () {
        const existing = runs.get(input.projectId);
        if (existing?.state === "generating") return yield* get(input);
        const context = yield* collect(input.projectId);
        const cached = yield* stored(input.projectId, context.project.workspaceRoot);
        const now = yield* Clock.currentTimeMillis;
        if (!context.sources.length) {
          runs.set(input.projectId, {
            state: "idle",
            digest: context.digest,
            attemptedAt: now,
            contextAvailable: false,
            message: null,
          });
          yield* sql`DELETE FROM project_overviews WHERE project_id=${input.projectId}`.pipe(
            Effect.mapError(unavailable),
          );
          yield* PubSub.publish(changes, input.projectId);
          return yield* get(input);
        }
        if (!input.force && cached?.sourceDigest === context.digest) {
          runs.delete(input.projectId);
          yield* PubSub.publish(changes, input.projectId);
          return yield* get(input);
        }
        // An unavailable provider must not turn every mount into another failed model call.
        if (
          !input.force &&
          existing?.state === "error" &&
          existing.digest === context.digest &&
          now - existing.attemptedAt < 60_000
        ) {
          return yield* get(input);
        }
        const owner: Run = {
          state: "generating",
          digest: context.digest,
          attemptedAt: now,
          contextAvailable: true,
          message: null,
        };
        runs.set(input.projectId, owner);
        yield* PubSub.publish(changes, input.projectId);
        const work = Effect.gen(function* () {
          const generate = generation.generateIdeas;
          if (!generate)
            return yield* new ProjectOverviewError({
              message: "Choose a supported text generation model to suggest project next steps.",
            });
          const result = yield* generate({
            cwd: config.stateDir,
            count: 3,
            context: context.context,
            project: { id: input.projectId, title: context.project.title },
            modelSelection: context.modelSelection,
          }).pipe(
            Effect.scoped,
            Effect.tapError((error) =>
              Effect.logWarning("Project next steps generation failed", {
                projectId: input.projectId,
                operation: error.operation,
              }),
            ),
            Effect.mapError(
              () =>
                new ProjectOverviewError({
                  message:
                    "Couldn't update next steps. Check the text generation provider and try again.",
                }),
            ),
          );
          const knownRefs = new Set(context.sources.map((source) => source.ref));
          const nextSteps = result.ideas
            .flatMap((idea) => {
              if (idea.projectId !== input.projectId || !knownRefs.has(idea.ref)) return [];
              const refs = [...new Set([idea.ref, ...idea.sources])];
              if (refs.some((ref) => !knownRefs.has(ref))) return [];
              const step = {
                id: digest({ topic: idea.topic, prompt: idea.prompt }).slice(0, 24),
                title: idea.title.trim().slice(0, 160),
                reason: idea.body.trim().slice(0, 800),
                prompt: idea.prompt.trim().slice(0, 4_000),
                sources: refs.slice(0, 5),
              };
              return step.title && step.reason && step.prompt ? [step] : [];
            })
            .slice(0, 4);
          const generatedAt = DateTime.formatIso(
            DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
          );
          const overview = yield* decodeOverview({
            description: result.description?.trim(),
            nextSteps,
            sources: context.sources,
            sourceDigest: context.digest,
            generatedAt,
            modelSelection: context.modelSelection,
          }).pipe(
            Effect.mapError(
              () =>
                new ProjectOverviewError({
                  message: "The model did not return a usable project description. Try refreshing.",
                }),
            ),
          );
          yield* locks.withLock(
            input.projectId,
            Effect.gen(function* () {
              const current = yield* projectFor(input.projectId);
              if (runs.get(input.projectId) !== owner) return;
              if (current.workspaceRoot !== context.project.workspaceRoot) {
                return yield* new ProjectOverviewError({
                  message: "The project location changed. Refresh next steps.",
                });
              }
              yield* sql`
              INSERT INTO project_overviews (project_id,workspace_root,overview_json)
              VALUES (${input.projectId},${current.workspaceRoot},${encodeStored(overview)})
              ON CONFLICT(project_id) DO UPDATE SET workspace_root=excluded.workspace_root,overview_json=excluded.overview_json
            `.pipe(Effect.mapError(unavailable));
              owner.state = "idle";
            }),
          );
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              if (runs.get(input.projectId) === owner) {
                owner.state = "error";
                owner.message = error.message;
              }
            }),
          ),
          Effect.ensuring(PubSub.publish(changes, input.projectId)),
          Effect.asVoid,
        );
        owner.fiber = yield* work.pipe(Effect.forkIn(scope));
        return yield* get(input);
      }),
    );
  });

  // Archiving, restoring or deleting a cited thread changes what get() may show.
  yield* forkParked(
    orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) =>
          event.type === "thread.archived" ||
          event.type === "thread.unarchived" ||
          event.type === "thread.deleted",
      ),
      Stream.runForEach((event) =>
        sql<{ projectId: ProjectId }>`
          SELECT project_id AS "projectId" FROM harness_activity_threads
          WHERE thread_id=${event.threadId}
        `.pipe(
          Effect.flatMap(([row]) => (row ? PubSub.publish(changes, row.projectId) : Effect.void)),
          Effect.ignore,
        ),
      ),
      Effect.ignore,
    ),
  );

  return ProjectOverview.of({
    get,
    ensure,
    subscribe: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(get(input)),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((projectId) => projectId === input.projectId),
              Stream.mapEffect(() => get(input)),
            ),
          );
        }),
      ),
    awaitIdle: (projectId) =>
      Effect.suspend(() => {
        const fiber = runs.get(projectId)?.fiber;
        return fiber ? Fiber.join(fiber) : Effect.void;
      }),
  });
});

export const layer = Layer.effect(ProjectOverview, make);
