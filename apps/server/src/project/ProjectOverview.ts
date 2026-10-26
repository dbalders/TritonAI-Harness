// @effect-diagnostics nodeBuiltinImport:off -- Cache identity is a deterministic content digest.
import * as NodeCrypto from "node:crypto";
import {
  type IntegrationSummary,
  ProjectOverview as Overview,
  type ProjectOverviewDismissInput,
  ProjectOverviewError,
  type ProjectOverviewEnsureInput,
  type ProjectOverviewGetInput,
  type ProjectOverviewRestoreInput,
  type ProjectOverviewOpenInput,
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
import { listEnabledIntegrations } from "../integrations/IntegrationRegistry.ts";
import * as ExternalContent from "../integrations/ExternalContent.ts";
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
const sameTitle = (left: string, right: string) =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

/** What TritonAI can already do here, so suggestions do not ask to build or ship it again. */
const formatPluginSource = (
  integrations: ReadonlyArray<IntegrationSummary>,
): ProjectOverviewSource | null => {
  if (!integrations.length) return null;
  const lines = integrations
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .map((integration) => {
      const tools = integration.tools
        .filter((tool) => tool.available)
        .map((tool) => tool.displayName)
        .join(", ");
      const signIn =
        integration.requiresConnection && integration.connectionState !== "connected"
          ? " (needs sign-in)"
          : "";
      return `- ${integration.name} ${integration.version}${signIn}: ${tools || "no tools available"}`.slice(
        0,
        600,
      );
    });
  return {
    ref: "plugin:enabled",
    title: "Plugins turned on in TritonAI",
    threadId: null,
    text: ["Installed and turned on now:", ...lines].join("\n").slice(0, 4_000),
  };
};

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
    /** Hides a suggested step and keeps future suggestions from repeating it. */
    readonly dismiss: (
      input: ProjectOverviewDismissInput,
    ) => Effect.Effect<ProjectOverviewSnapshot, ProjectOverviewError>;
    /** Brings back one dismissed step, or all of them, so suggestions may include them again. */
    readonly restore: (
      input: ProjectOverviewRestoreInput,
    ) => Effect.Effect<ProjectOverviewSnapshot, ProjectOverviewError>;
    readonly open: (
      input: ProjectOverviewOpenInput,
    ) => Effect.Effect<boolean, ProjectOverviewError>;
    readonly awaitIdle: (projectId: ProjectId) => Effect.Effect<void>;
  }
>()("t3/project/ProjectOverview") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const memory = yield* DailyMemory.DailyMemory;
  const externalContent = yield* ExternalContent.ExternalContent;
  const settings = yield* ServerSettings.ServerSettingsService;
  const generation = yield* TextGeneration.TextGeneration;
  const config = yield* ServerConfig.ServerConfig;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const scope = yield* Effect.scope;
  const locks = yield* KeyedLock.make<ProjectId>();
  const changes = yield* PubSub.sliding<ProjectId>(32);
  const runs = new Map<ProjectId, Run>();

  const projectFor = Effect.fn("ProjectOverview.projectFor")(function* (projectId: ProjectId) {
    const rows = yield* sql<{ title: string; workspaceRoot: string }>`
        SELECT title, workspace_root AS "workspaceRoot" FROM projection_projects
        WHERE project_id=${projectId} AND deleted_at IS NULL
      `.pipe(Effect.mapError(unavailable));
    if (!rows[0])
      return yield* new ProjectOverviewError({ message: "This project is no longer available." });
    return rows[0];
  });

  const stored = Effect.fn("ProjectOverview.stored")(function* (
    projectId: ProjectId,
    workspaceRoot: string,
  ) {
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

  const dismissals = (projectId: ProjectId) =>
    sql<{ stepId: string; title: string; kind: string }>`
      SELECT step_id AS "stepId", title, kind FROM project_next_step_dismissals
      WHERE project_id=${projectId} ORDER BY created_at DESC, step_id
    `.pipe(Effect.mapError(unavailable));

  const get = Effect.fn("ProjectOverview.get")(function* (input: ProjectOverviewGetInput) {
    const project = yield* projectFor(input.projectId);
    const overview = yield* stored(input.projectId, project.workspaceRoot);
    const dismissed = yield* dismissals(input.projectId);
    const run = runs.get(input.projectId);
    return {
      projectId: input.projectId,
      // Hidden at read time rather than dropped when generated, so Restore can bring a step back.
      overview: overview && {
        ...overview,
        nextSteps: overview.nextSteps.filter(
          (step) =>
            !dismissed.some((row) => row.stepId === step.id || sameTitle(row.title, step.title)),
        ),
      },
      contextAvailable: run?.contextAvailable ?? overview !== null,
      generation: { state: run?.state ?? "idle", message: run?.message ?? null },
      dismissedCount: dismissed.length,
    } satisfies ProjectOverviewSnapshot;
  });

  const collect = Effect.fn("ProjectOverview.collect")(function* (projectId: ProjectId) {
    const project = yield* projectFor(projectId);
    const rows = yield* sql<{
      threadId: string;
      title: string;
      settledAt: string | null;
      snoozedUntil: string | null;
      lastMessageAt: string;
      userId: string | null;
      userText: string | null;
      assistantId: string | null;
      assistantText: string | null;
    }>`
      WITH recent AS (
        SELECT t.thread_id, t.title, t.settled_at, t.snoozed_until
        FROM harness_activity_threads t
        WHERE t.project_id=${projectId} AND t.deleted_at IS NULL AND t.archived_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_threads v
            WHERE v.thread_id=t.thread_id
              AND json_extract(v.payload_json, '$.lineage.relationshipToParent')='subagent'
          )
        ORDER BY t.updated_at DESC, t.thread_id LIMIT 20
      )
      SELECT t.thread_id AS "threadId", t.title,
        t.settled_at AS "settledAt", t.snoozed_until AS "snoozedUntil",
        max(coalesce(u.created_at,''),coalesce(a.created_at,'')) AS "lastMessageAt",
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
    const nowIso = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    const sources: ProjectOverviewSource[] = rows
      .filter((row) => row.userText || row.assistantText)
      .map((row) => ({
        ref: `thread:${row.threadId}`,
        title: row.title.slice(0, 300) || "Project thread",
        threadId: ThreadId.make(row.threadId),
        text: [
          // Dated by the excerpted messages, so only new messages or a status change refresh the cache.
          `Thread status: ${
            row.settledAt !== null
              ? "settled (the user marked it handled)"
              : row.snoozedUntil !== null && row.snoozedUntil > nowIso
                ? "snoozed"
                : "active"
          }; last message ${row.lastMessageAt.slice(0, 10)}.`,
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
          // Plugins and dismissals stay out of the digest: reading plugin status is slow, and a
          // dismissal hides its step immediately, so neither should force a model call on open.
          const plugins = formatPluginSource(yield* listEnabledIntegrations);
          const sources = plugins ? [...context.sources, plugins] : context.sources;
          const dismissed = yield* dismissals(input.projectId);
          const provenanceOwner = `project-overview:${input.projectId}:${context.digest}`;
          for (const source of context.sources) {
            if (source.threadId !== null)
              yield* externalContent
                .inherit(`thread:${source.threadId}`, provenanceOwner)
                .pipe(Effect.mapError(unavailable));
            else
              yield* externalContent
                .markUnverified(provenanceOwner, {
                  kind: "derived",
                  artifactKind: "memory",
                  artifactId: source.ref,
                  contentDigest: digest(source.text),
                })
                .pipe(Effect.mapError(unavailable));
          }
          const result = yield* generate({
            cwd: config.stateDir,
            count: 3,
            context: encodeJson({
              today: DateTime.formatIso(DateTime.makeUnsafe(now)).slice(0, 10),
              project: { id: input.projectId, title: context.project.title },
              sources,
              avoid: dismissed.slice(0, 40).map((row) => ({
                title: row.title,
                because: row.kind === "done" ? "already done" : "not relevant",
              })),
            }),
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
          const knownRefs = new Set(sources.map((source) => source.ref));
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
            sources,
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
              INSERT INTO project_overviews (project_id,workspace_root,overview_json,provenance_recorded)
              VALUES (${input.projectId},${current.workspaceRoot},${encodeStored(overview)},1)
              ON CONFLICT(project_id) DO UPDATE SET workspace_root=excluded.workspace_root,overview_json=excluded.overview_json,provenance_recorded=1
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

  const open = Effect.fn("ProjectOverview.open")(function* (input: ProjectOverviewOpenInput) {
    return yield* locks.withLock(
      input.projectId,
      Effect.gen(function* () {
        const project = yield* projectFor(input.projectId);
        const overview = yield* stored(input.projectId, project.workspaceRoot);
        if (
          overview?.sourceDigest !== input.sourceDigest ||
          !overview.nextSteps.some((step) => step.id === input.stepId)
        )
          return yield* new ProjectOverviewError({
            message: "This suggestion changed. Refresh next steps before opening it.",
          });
        // Reconcile every input again: a source may have narrowed since generation.
        for (const source of overview.sources)
          if (source.threadId !== null)
            yield* externalContent
              .inherit(
                `thread:${source.threadId}`,
                `project-overview:${input.projectId}:${overview.sourceDigest}`,
              )
              .pipe(Effect.mapError(unavailable));
        const rows = yield* sql<{ recorded: number }>`SELECT provenance_recorded AS recorded
      FROM project_overviews WHERE project_id=${input.projectId} AND workspace_root=${project.workspaceRoot}`.pipe(
          Effect.mapError(unavailable),
        );
        const owner = `project-overview:${input.projectId}:${overview.sourceDigest}`;
        if (rows[0]?.recorded !== 1)
          yield* externalContent
            .markUnverified(owner, {
              kind: "derived",
              artifactKind: "project-overview",
              artifactId: input.projectId,
              contentDigest: digest(overview),
            })
            .pipe(Effect.mapError(unavailable));
        yield* externalContent
          .inherit(owner, `thread:${input.draftThreadId}`)
          .pipe(Effect.mapError(unavailable));
        return true;
      }),
    );
  });

  const dismiss = Effect.fn("ProjectOverview.dismiss")(function* (
    input: ProjectOverviewDismissInput,
  ) {
    const project = yield* projectFor(input.projectId);
    const step = (yield* stored(input.projectId, project.workspaceRoot))?.nextSteps.find(
      (candidate) => candidate.id === input.stepId,
    );
    if (!step)
      return yield* new ProjectOverviewError({
        message: "This suggestion is no longer available. Refresh next steps.",
      });
    const createdAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    yield* sql`
      INSERT INTO project_next_step_dismissals (project_id,step_id,title,kind,created_at)
      VALUES (${input.projectId},${step.id},${step.title},${input.kind},${createdAt})
      ON CONFLICT(project_id,step_id) DO UPDATE SET kind=excluded.kind,created_at=excluded.created_at
    `.pipe(Effect.mapError(unavailable));
    yield* PubSub.publish(changes, input.projectId);
    return yield* get(input);
  });

  const restore = Effect.fn("ProjectOverview.restore")(function* (
    input: ProjectOverviewRestoreInput,
  ) {
    const project = yield* projectFor(input.projectId);
    const restored = (yield* dismissals(input.projectId)).filter(
      (row) => input.stepId === undefined || row.stepId === input.stepId,
    );
    yield* (
      input.stepId === undefined
        ? sql`DELETE FROM project_next_step_dismissals WHERE project_id=${input.projectId}`
        : sql`DELETE FROM project_next_step_dismissals
            WHERE project_id=${input.projectId} AND step_id=${input.stepId}`
    ).pipe(Effect.mapError(unavailable));
    yield* PubSub.publish(changes, input.projectId);
    // A regeneration that honored the avoid list never stored the step, so ask again without it.
    const cached = (yield* stored(input.projectId, project.workspaceRoot))?.nextSteps ?? [];
    const missing = restored.some(
      (row) => !cached.some((step) => step.id === row.stepId || sameTitle(step.title, row.title)),
    );
    return yield* missing ? ensure({ projectId: input.projectId, force: true }) : get(input);
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
    dismiss,
    restore,
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
    open,
    awaitIdle: (projectId) =>
      Effect.suspend(() => {
        const fiber = runs.get(projectId)?.fiber;
        return fiber ? Fiber.join(fiber) : Effect.void;
      }),
  });
});

export const layer = Layer.effect(ProjectOverview, make);
