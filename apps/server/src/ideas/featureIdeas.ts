/**
 * TritonAI features worth trying, each as a ready-to-send example. A card is
 * offered only until the user has tried its feature anywhere in the app; the
 * record the feature leaves behind is how we know.
 */
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import { compactDynamicToolOutput, htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import type { CandidateIdea } from "./ideaContext.ts";

export interface FeatureIdea {
  readonly id: string;
  readonly icon: string;
  readonly title: string;
  readonly body: string;
  readonly prompt: string;
  /** Whether the user has already used this feature. */
  readonly used: (sql: SqlClient.SqlClient) => Effect.Effect<boolean, SqlError.SqlError>;
}

const found = Effect.map((rows: ReadonlyArray<{ readonly used: number }>) =>
  Boolean(rows[0]?.used),
);

interface ToolCall {
  readonly toolName: string | null | undefined;
  readonly output: unknown;
}

const decodeToolCall = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      toolName: Schema.optional(Schema.NullOr(Schema.String)),
      output: Schema.optional(Schema.Unknown),
    }),
  ),
);

const TOOL_CALL_PAGE = 20;

/**
 * Whether any stored call of a TritonAI tool passes `succeeded`, which must
 * check the tool's identity: the text and name matches only narrow the search.
 * Reads candidates a page at a time, without their input, until one passes.
 */
const anyToolCall = Effect.fn("ideas.anyToolCall")(function* (
  sql: SqlClient.SqlClient,
  search: {
    readonly text: string;
    readonly tool: string;
    readonly succeeded: (call: ToolCall) => boolean;
  },
) {
  let after = 0;
  for (;;) {
    const rows = yield* sql<{ readonly rowId: number; readonly call: string }>`
      SELECT rowid AS "rowId",
        json_object(
          'toolName', json_extract(payload_json, '$.toolName'),
          'output', json_extract(payload_json, '$.output')
        ) AS "call"
      FROM orchestration_v2_projection_turn_items
      WHERE rowid > ${after}
        AND type = 'dynamic_tool'
        AND payload_json LIKE ${`%${search.text}%`}
        AND json_extract(payload_json, '$.toolName') LIKE ${`%${search.tool}%`}
      ORDER BY rowid
      LIMIT ${TOOL_CALL_PAGE}
    `;
    const passed = rows.some((row) =>
      Option.match(decodeToolCall(row.call), {
        onNone: () => false,
        onSome: (call) => search.succeeded({ toolName: call.toolName, output: call.output }),
      }),
    );
    if (passed) return true;
    const last = rows.at(-1);
    if (rows.length < TOOL_CALL_PAGE || last === undefined) return false;
    after = last.rowId;
  }
});

export const FEATURE_IDEAS: ReadonlyArray<FeatureIdea> = [
  {
    id: "subagents",
    icon: "👥",
    title: "Have helpers research three things at once",
    body: "Helper agents work on parts of a job at the same time.",
    prompt:
      "Compare three ways a campus office could run hybrid meetings: a Microsoft Teams Room, a Zoom Room, and a laptop with a conference speaker. Start exactly three subagents, one for each option, so they work at the same time. Each should answer from what it already knows, without browsing the web, running commands, or opening files. Then combine their answers into one table with rough cost, setup effort, and accessibility, and recommend one.",
    // Helpers started by TritonAI and the provider's own both count.
    used: (sql) =>
      sql<{ readonly used: number }>`
        SELECT EXISTS (SELECT 1 FROM orchestration_v2_projection_subagents) AS "used"
      `.pipe(found),
  },
  {
    id: "agent-threads",
    icon: "🧵",
    title: "Let TritonAI split a project into its own threads",
    body: "TritonAI starts a separate thread for each piece of a plan.",
    prompt:
      "Help me plan a department open house by starting three new threads in this project: one to draft the invitation email, one to draft the day-of schedule, and one to draft the supply list. In each thread's first message, ask for a short draft written right in that thread, without browsing the web, running commands, or saving files. Then list the threads you started here, with a one-line summary of each.",
    // A thread an agent started with TritonAI's tools, other than a helper's own thread.
    used: (sql) =>
      sql<{ readonly used: number }>`
        SELECT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_threads
          WHERE json_extract(payload_json, '$.creationSource') = 'mcp'
            AND json_extract(payload_json, '$.lineage.relationshipToParent') IS NULL
        ) AS "used"
      `.pipe(found),
  },
  {
    id: "scheduled-tasks",
    icon: "⏰",
    title: "Get a recap of your week every Monday",
    body: "Runs a request on a timetable. Pause or delete it in Settings.",
    prompt:
      "Set up a scheduled task that runs every Monday at 9:00 AM and sends a short recap to this thread of what I worked on in TritonAI the week before: the main threads, what got finished, and anything still waiting on me. Once it's set up, tell me when it will first run and how to pause or delete it.",
    // Deleting a task removes its row, so a task that ran or that an agent made counts too.
    // A task made in Settings and deleted before it ran, while Ideas was closed, leaves no trace.
    used: (sql) =>
      sql<{ readonly used: number }>`
        SELECT (
          EXISTS (SELECT 1 FROM scheduled_tasks)
          OR EXISTS (
            SELECT 1 FROM orchestration_v2_projection_messages
            WHERE role = 'user'
              AND payload_json LIKE '%scheduledTaskId%'
              AND json_extract(payload_json, '$.scheduledTaskId') IS NOT NULL
          )
        ) AS "used"
      `.pipe(
        found,
        Effect.flatMap((used) =>
          used
            ? Effect.succeed(true)
            : anyToolCall(sql, {
                text: "scheduledTaskId",
                tool: "schedule_task",
                succeeded: (call) => {
                  const output = compactDynamicToolOutput(call.output);
                  return (
                    resolveT3McpToolId(call.toolName) === "schedule_task" &&
                    output?.isError !== true &&
                    output?.scheduledTaskId !== undefined
                  );
                },
              }),
        ),
      ),
  },
  {
    id: "visual-replies",
    icon: "📈",
    title: "Ask for a chart instead of a paragraph",
    body: "Answers can come back as a chart, table, or diagram right in the thread.",
    prompt:
      "Show me a chart, right here in the thread, of how a made-up campus help desk's tickets changed over the last twelve months, split into accounts, Wi-Fi, printing, and software. Use realistic sample numbers and label them as sample data, then add two sentences on what the chart shows. Don't save any files.",
    // A page an agent showed in a thread. This reads tool calls, so it is checked sparingly.
    used: (sql) =>
      anyToolCall(sql, {
        text: "htmlRender",
        tool: "html_render",
        succeeded: (call) => htmlRenderFromToolItem(call) !== undefined,
      }),
  },
];

export const featureKey = (feature: Pick<FeatureIdea, "id">) => `feature:${feature.id}`;

/** A feature card, word for word, as it is stored. */
export function featureCandidate(feature: FeatureIdea): CandidateIdea {
  const key = featureKey(feature);
  return {
    key,
    subject: key,
    section: "feature",
    icon: feature.icon,
    title: feature.title,
    body: feature.body,
    sources: [],
    action: { kind: "new-thread", projectId: null, prompt: feature.prompt },
  };
}
