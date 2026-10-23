// @effect-diagnostics nodeBuiltinImport:off - Synchronous SHA-256 document fingerprints and campus identity keys use Node crypto.
import { TeamsError, TeamStorage, ProjectId, type ThreadId } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** Server-owned authority survives a queued message, composer edits, and server restarts. */
const Reference = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  issuer: Schema.String,
  subject: Schema.String,
  projectId: ProjectId,
  link: Schema.Struct({
    projectId: ProjectId,
    teamId: Schema.String,
    storage: TeamStorage,
    linkedAt: Schema.String,
    sharingSince: Schema.optionalKey(Schema.String),
  }),
  block: Schema.String,
  applied: Schema.optionalKey(Schema.Literal(true)),
  path: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
});
export type Reference = typeof Reference.Type;
const Binding = Schema.Struct({
  messageId: Schema.String,
  threadId: Schema.String,
  textHash: Schema.String,
  references: Schema.Array(Reference),
});
const ReferenceJson = Schema.fromJsonString(Reference);
const BindingJson = Schema.fromJsonString(Binding);
const decodeReference = Schema.decodeUnknownEffect(ReferenceJson);
const decodeBinding = Schema.decodeUnknownEffect(BindingJson);
const encodeReference = Schema.encodeEffect(ReferenceJson);
const encodeBinding = Schema.encodeEffect(BindingJson);
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const key = (messageId: string, text: string) => `${messageId}:${hash(text)}`;
const authorityKey = (reference: Reference) =>
  hash(
    JSON.stringify([
      reference.sessionId,
      reference.issuer,
      reference.subject,
      reference.projectId,
      reference.link.teamId,
      reference.link.linkedAt,
      reference.link.storage.tenantId,
      reference.link.storage.siteId,
      reference.link.storage.driveId,
      reference.link.storage.folderId,
      reference.block,
      reference.applied,
      reference.path,
      reference.version,
    ]),
  );
const uniqueReferences = (references: readonly Reference[]) => [
  ...new Map(references.map((reference) => [reference.id, reference])).values(),
];
const unavailable = () =>
  new TeamsError({
    code: "unavailable",
    message: "Team message access could not be checked. Try again before sending.",
  });

export class TeamMessageGate extends Context.Service<
  TeamMessageGate,
  {
    readonly remember: (reference: Reference) => Effect.Effect<Reference, TeamsError>;
    readonly get: (id: string) => Effect.Effect<Reference | null, TeamsError>;
    readonly matching: (input: {
      readonly text: string;
      readonly sessionId: string;
      readonly issuer: string;
      readonly subject: string;
      readonly projectId: ProjectId;
    }) => Effect.Effect<readonly Reference[], TeamsError>;
    readonly bind: (input: {
      readonly messageId: string;
      readonly threadId: ThreadId;
      readonly text: string;
      readonly references: readonly Reference[];
    }) => Effect.Effect<void, TeamsError>;
    readonly previous: (messageId: string) => Effect.Effect<readonly Reference[], TeamsError>;
    readonly registerValidator: (
      validate: (reference: Reference) => Effect.Effect<void, TeamsError>,
    ) => Effect.Effect<void>;
    readonly verifyBeforeSend: (input: {
      readonly messageId: string;
      readonly threadId: ThreadId;
      readonly text: string;
    }) => Effect.Effect<void, TeamsError>;
  }
>()("t3/teams/TeamMessageGate") {}

interface Store {
  readonly get: (
    table: "teams_issued_references" | "teams_message_contexts",
    id: string,
  ) => Effect.Effect<string | null, TeamsError>;
  readonly set: (
    table: "teams_issued_references" | "teams_message_contexts",
    id: string,
    json: string,
  ) => Effect.Effect<void, TeamsError>;
  readonly list: (
    table: "teams_issued_references" | "teams_message_contexts",
    messageId?: string,
  ) => Effect.Effect<readonly string[], TeamsError>;
}

const make = (store: Store) =>
  Effect.sync(() => {
    let validator: ((reference: Reference) => Effect.Effect<void, TeamsError>) | undefined;
    const references = () =>
      store
        .list("teams_issued_references")
        .pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) => decodeReference(row).pipe(Effect.mapError(unavailable))),
          ),
        );
    const previous = (messageId: string) =>
      store.list("teams_message_contexts", messageId).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) => decodeBinding(row).pipe(Effect.mapError(unavailable))),
        ),
        Effect.map((bindings) =>
          uniqueReferences(
            bindings
              .filter((binding) => binding.messageId === messageId)
              .flatMap((binding) => binding.references),
          ),
        ),
      );
    return TeamMessageGate.of({
      remember: Effect.fn("TeamMessageGate.remember")(function* (reference: Reference) {
        // Automatic skills recur on every message. Reuse their ID so they neither evict
        // an unsent draft nor expire a queued message's projected reference IDs.
        if (reference.applied)
          for (const existing of yield* references()) {
            if (existing.applied && authorityKey(existing) === authorityKey(reference))
              return existing;
          }
        yield* store.set(
          "teams_issued_references",
          reference.id,
          yield* encodeReference(reference).pipe(Effect.mapError(unavailable)),
        );
        return reference;
      }),
      get: (id) =>
        store
          .get("teams_issued_references", id)
          .pipe(
            Effect.flatMap((json) =>
              json === null
                ? Effect.succeed(null)
                : decodeReference(json).pipe(Effect.mapError(unavailable)),
            ),
          ),
      matching: (input) =>
        !/<team-(?:memory|skill)\s/u.test(input.text)
          ? Effect.succeed([])
          : references().pipe(
              Effect.map((entries) => [
                ...new Map(
                  entries
                    .filter(
                      (entry) =>
                        entry.sessionId === input.sessionId &&
                        entry.issuer === input.issuer &&
                        entry.subject === input.subject &&
                        entry.projectId === input.projectId &&
                        input.text.includes(entry.block),
                    )
                    .map((entry) => [entry.block, entry]),
                ).values(),
              ]),
            ),
      bind: Effect.fn("TeamMessageGate.bind")(function* (
        input: Parameters<TeamMessageGate["Service"]["bind"]>[0],
      ) {
        if (input.references.length === 0) return;
        const existingJson = yield* store.get(
          "teams_message_contexts",
          key(input.messageId, input.text),
        );
        const existing =
          existingJson === null
            ? null
            : yield* decodeBinding(existingJson).pipe(Effect.mapError(unavailable));
        if (existing && existing.threadId !== input.threadId)
          return yield* new TeamsError({
            code: "conflict",
            message: "This message already belongs to another thread.",
          });
        const references = uniqueReferences([...(existing?.references ?? []), ...input.references]);
        yield* store.set(
          "teams_message_contexts",
          key(input.messageId, input.text),
          yield* encodeBinding({
            messageId: input.messageId,
            threadId: input.threadId,
            references,
            textHash: hash(input.text),
          }).pipe(Effect.mapError(unavailable)),
        );
      }),
      previous,
      registerValidator: (validate) =>
        Effect.sync(() => {
          validator = validate;
        }),
      verifyBeforeSend: Effect.fn("TeamMessageGate.verifyBeforeSend")(function* (
        input: Parameters<TeamMessageGate["Service"]["verifyBeforeSend"]>[0],
      ) {
        const json = yield* store.get("teams_message_contexts", key(input.messageId, input.text));
        if (json === null) {
          if ((yield* previous(input.messageId)).length > 0)
            return yield* new TeamsError({
              code: "conflict",
              message:
                "This queued team message changed without a new access check. Edit it again before sending.",
            });
          return;
        }
        const binding = yield* decodeBinding(json).pipe(Effect.mapError(unavailable));
        if (binding.threadId !== input.threadId || binding.textHash !== hash(input.text))
          return yield* unavailable();
        if (validator === undefined) return yield* unavailable();
        for (const reference of binding.references)
          yield* validator(reference).pipe(
            Effect.mapError(
              (error) =>
                new TeamsError({
                  code: error.code,
                  message: `${error.message} Restore team access to send this queued message, or cancel it and compose a new message without team context.`,
                }),
            ),
          );
      }),
    });
  });

export const layer = Layer.effect(
  TeamMessageGate,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const column = (table: "teams_issued_references" | "teams_message_contexts") =>
      table === "teams_issued_references" ? "id" : "context_key";
    return yield* make({
      get: (table, id) =>
        sql<{
          payload_json: string;
        }>`SELECT payload_json FROM ${sql(table)} WHERE ${sql(column(table))} = ${id}`.pipe(
          Effect.map((rows) => rows[0]?.payload_json ?? null),
          Effect.mapError(unavailable),
        ),
      set: Effect.fn("TeamMessageGate.store.set")(function* (
        table: Parameters<Store["set"]>[0],
        id: string,
        json: string,
      ) {
        const row =
          table === "teams_message_contexts"
            ? {
                context_key: id,
                message_id: (yield* decodeBinding(json).pipe(Effect.mapError(unavailable)))
                  .messageId,
                payload_json: json,
              }
            : { id, payload_json: json };
        yield* sql`INSERT INTO ${sql(table)} ${sql.insert(row)} ON CONFLICT(${sql(column(table))}) DO UPDATE SET payload_json = excluded.payload_json`.pipe(
          Effect.mapError(unavailable),
        );
        if (table === "teams_issued_references")
          yield* sql`DELETE FROM teams_issued_references WHERE rowid NOT IN (SELECT rowid FROM teams_issued_references ORDER BY rowid DESC LIMIT 256)`.pipe(
            Effect.mapError(unavailable),
          );
      }),
      list: (table, messageId) =>
        (messageId === undefined
          ? sql<{ payload_json: string }>`SELECT payload_json FROM ${sql(table)} ORDER BY rowid`
          : sql<{
              payload_json: string;
            }>`SELECT payload_json FROM teams_message_contexts WHERE message_id = ${messageId}`
        ).pipe(
          Effect.map((rows) => rows.map((row) => row.payload_json)),
          Effect.mapError(unavailable),
        ),
    });
  }),
);

/** A persistent map can be retained across service reconstruction in focused tests. */
export const layerMemory = (values = new Map<string, string>()) =>
  Layer.effect(
    TeamMessageGate,
    make({
      get: (table, id) => Effect.sync(() => values.get(`${table}:${id}`) ?? null),
      set: (table, id, json) =>
        Effect.sync(() => {
          values.set(`${table}:${id}`, json);
          if (table === "teams_issued_references") {
            const keys = [...values.keys()].filter((key) => key.startsWith(`${table}:`));
            for (const old of keys.slice(0, -256)) values.delete(old);
          }
        }),
      list: Effect.fn("TeamMessageGate.memory.list")(function* (
        table: Parameters<Store["list"]>[0],
        messageId?: string,
      ) {
        const rows = [...values]
          .filter(([id]) => id.startsWith(`${table}:`))
          .map(([, value]) => value);
        if (messageId === undefined) return rows;
        const selected = [];
        for (const row of rows)
          if (
            (yield* decodeBinding(row).pipe(Effect.mapError(unavailable))).messageId === messageId
          )
            selected.push(row);
        return selected;
      }),
    }),
  );
