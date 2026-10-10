import {
  type TeamDocument,
  type TeamDocumentChange,
  type TeamDocumentVersion,
  type TeamStorage,
  type TeamStorageCommand,
  type TeamStorageStatus,
  formatTeamNote,
  hasHiddenTeamText,
  summarizeTeamNote,
  type TeamDocumentSummary,
  TeamsError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";

const MAX_BYTES = 64 * 1024;
const roots = { memory: "Memory", sop: "SOPs", skill: "Skills" } as const;
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const documentPath = new RegExp(
  `^(Memory|SOPs|Skills)/([A-Za-z0-9_-]{43})/(${uuid})/(${uuid})\\.md$`,
  "u",
);
const Modifier = Schema.Struct({
  displayName: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
});
const Modified = Schema.Struct({
  lastModifiedDateTime: Schema.optionalKey(Schema.String),
  lastModifiedBy: Schema.optionalKey(
    Schema.Struct({
      user: Schema.optionalKey(Modifier),
      application: Schema.optionalKey(Modifier),
    }),
  ),
});
const Item = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  eTag: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Schema.Int),
  parentReference: Schema.Struct({ id: Schema.String }),
  folder: Schema.optionalKey(Schema.Struct({})),
  file: Schema.optionalKey(Schema.Struct({})),
  remoteItem: Schema.optionalKey(Schema.Unknown),
  "@microsoft.graph.downloadUrl": Schema.optionalKey(Schema.String),
  ...Modified.fields,
});
const Version = Schema.Struct({
  id: Schema.String,
  size: Schema.optionalKey(Schema.Int),
  ...Modified.fields,
});
const Versions = Schema.Struct({ value: Schema.Array(Version) });
/** Kept versions a history lists; SharePoint keeps up to 500 by default. */
const MAX_VERSIONS = 50;
const unavailable = (message: string) => new TeamsError({ code: "unavailable", message });
const conflict = () =>
  new TeamsError({
    code: "conflict",
    message:
      "This document changed. Reopen it before saving or deleting; your draft has been kept.",
  });
const invalid = () =>
  new TeamsError({
    code: "invalid_request",
    message: "Only Harness team documents can be opened or changed here.",
  });
const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(Item));
const decodeVersions = Schema.decodeUnknownEffect(Schema.fromJsonString(Versions));
const decodeVersion = Schema.decodeUnknownEffect(Schema.fromJsonString(Version));
const versionId = /^[A-Za-z0-9._-]{1,32}$/u;

/**
 * Who SharePoint says last saved an item or version, and when. Names are Microsoft display names,
 * so hidden and control characters are removed before anyone reads them.
 */
const changeOf = (modified: typeof Modified.Type): TeamDocumentChange | undefined => {
  const at = DateTime.make(modified.lastModifiedDateTime ?? "");
  if (Option.isNone(at)) return undefined;
  const who = modified.lastModifiedBy?.user ?? modified.lastModifiedBy?.application;
  const name = Array.from(
    (who?.displayName || who?.email || "").replace(/[\p{Cc}\p{Cf}]/gu, "").trim(),
  )
    .slice(0, 60)
    .join("");
  return { by: name || "An unknown account", at: DateTime.formatIso(at.value) };
};
const withChange = <A extends object>(value: A, modified: typeof Modified.Type) => {
  const change = changeOf(modified);
  return change ? { ...value, lastChange: change } : value;
};

/** Bounds the stream itself, including a chunked response with no Content-Length. */
const readText = (response: HttpClientResponse.HttpClientResponse, max = MAX_BYTES) =>
  Effect.gen(function* () {
    let size = 0;
    const chunks: Uint8Array[] = [];
    yield* response.stream.pipe(
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          size += chunk.byteLength;
          if (size > max)
            return yield* unavailable("This document is too large to open in Harness.");
          chunks.push(chunk);
        }),
      ),
      Effect.mapError(() => unavailable("The document could not be read within its size limit.")),
    );
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => unavailable("The document is not valid UTF-8 text."),
    });
  });

/**
 * The signed download address Graph gave for an item, only on the team's own SharePoint site.
 * The trusted membership service pins that site. Never expose the signed URL or forward a Graph
 * bearer to its download host.
 */
const downloadUrl = (item: typeof Item.Type, storage: TeamStorage) =>
  signedUrl(item["@microsoft.graph.downloadUrl"] ?? "", storage);
const signedUrl = (address: string, storage: TeamStorage) =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(address),
      catch: () => unavailable("Shared storage did not provide a valid document download."),
    });
    const siteHost = storage.siteId.split(",")[0]?.toLowerCase() ?? "";
    if (
      url.protocol !== "https:" ||
      !/^[a-z0-9][a-z0-9-]*\.sharepoint\.com$/u.test(siteHost) ||
      url.hostname !== siteHost ||
      url.port ||
      url.username ||
      url.password
    )
      return yield* unavailable("Shared storage returned an unexpected download host.");
    return url;
  });

type DocumentCommand = Extract<
  TeamStorageCommand,
  {
    action:
      | "publish"
      | "read-file"
      | "update-file"
      | "delete-file"
      | "list-versions"
      | "read-version";
  }
>;
/** What a document command adds to the storage status: the document, or a history read. */
type DocumentResult = Pick<TeamStorageStatus, "document" | "history" | "priorVersion">;
type Send = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, TeamsError>;

/**
 * Team content never enters the personal memory directory or provider home. Version history is
 * read-only: SharePoint keeps it, and Harness lists and reads it but never restores a version.
 */
export const executeDocument = (input: {
  command: DocumentCommand;
  storage: TeamStorage;
  actorId: string;
  canWrite: boolean;
  canManage: boolean;
  send: Send;
  verifyCurrent: Effect.Effect<void, TeamsError>;
}) =>
  Effect.gen(function* () {
    const { command, storage, send, verifyCurrent } = input;
    const http = yield* HttpClient.HttpClient;
    const reading =
      command.action === "read-file" ||
      command.action === "list-versions" ||
      command.action === "read-version";
    if (!reading && !input.canWrite)
      return yield* new TeamsError({
        code: "forbidden",
        message: "You have read-only access to this team.",
      });
    const root = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(storage.driveId)}/items/`;
    const endpoint = (id: string) => `${root}${encodeURIComponent(id)}`;
    const download = (url: URL) =>
      Effect.gen(function* () {
        yield* verifyCurrent;
        return yield* http.execute(HttpClientRequest.get(url.href)).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.mapError(() => unavailable("The document download failed.")),
        );
      });
    const parse = (response: HttpClientResponse.HttpClientResponse) =>
      readText(response).pipe(
        Effect.flatMap(decodeItem),
        Effect.mapError(() => unavailable("Shared storage returned invalid document metadata.")),
      );
    const checked = (item: typeof Item.Type, parentId: string, name: string, folder: boolean) => {
      if (
        item.parentReference.id !== parentId ||
        item.name !== name ||
        item.remoteItem !== undefined ||
        (folder
          ? item.folder === undefined || item.file !== undefined
          : item.file === undefined || item.folder !== undefined)
      )
        return Effect.fail(
          unavailable("The document moved or its folder is no longer valid. Refresh this team."),
        );
      return Effect.succeed(item);
    };
    const child = (parentId: string, names: string[], folder: boolean, create: boolean) =>
      Effect.gen(function* () {
        yield* verifyCurrent;
        const name = names.at(-1)!;
        const url = `${endpoint(storage.folderId)}:/${names.map(encodeURIComponent).join("/")}`;
        const lookup = send(HttpClientRequest.get(url));
        let response = yield* lookup;
        if (response.status === 404 && folder && create) {
          const parentPath = names.slice(0, -1).map(encodeURIComponent).join("/");
          const collection = parentPath
            ? `${endpoint(storage.folderId)}:/${parentPath}:/children`
            : `${endpoint(storage.folderId)}/children`;
          response = yield* send(
            HttpClientRequest.post(collection).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                name,
                folder: {},
                "@microsoft.graph.conflictBehavior": "fail",
              }),
            ),
          );
          if (response.status === 409) response = yield* lookup;
        }
        if (response.status !== 200 && response.status !== 201)
          return yield* new TeamsError({
            code: response.status === 404 ? "not_found" : "unavailable",
            message: "The team document is unavailable. Refresh your membership and files.",
          });
        return yield* checked(yield* parse(response), parentId, name, folder);
      });
    const path =
      command.action === "publish"
        ? `${roots[command.kind]}/${input.actorId}/${command.deviceId}/${command.recordId}.md`
        : command.path;
    const match = documentPath.exec(path);
    if (!match) return yield* invalid();
    if (
      command.action === "delete-file" &&
      match[1] === "Memory" &&
      match[2] !== input.actorId &&
      !input.canManage
    )
      return yield* new TeamsError({
        code: "forbidden",
        message: "Only the author or a team owner can remove this memory note.",
      });
    // Skills become agent instructions: say what they are for, and keep nothing out of review.
    // Checked before any folder is created.
    if (
      match[1] === "Skills" &&
      (command.action === "publish" || command.action === "update-file")
    ) {
      if (command.action === "publish" && !command.description?.trim())
        return yield* new TeamsError({
          code: "invalid_request",
          message: "Describe what this skill is for before publishing it.",
        });
      if (hasHiddenTeamText(command.action === "publish" ? formatTeamNote(command) : command.text))
        return yield* new TeamsError({
          code: "invalid_request",
          message:
            "Skill documents can't contain hidden or control characters. Remove them and try again.",
        });
    }
    const parts = path.split("/");
    const locateParent = (create: boolean) =>
      Effect.gen(function* () {
        let id = storage.folderId;
        for (let depth = 1; depth < parts.length; depth++)
          id = (yield* child(id, parts.slice(0, depth), true, create)).id;
        return id;
      });
    const parentId = yield* locateParent(command.action === "publish");
    const filename = parts.at(-1)!;
    // Resolve mutations from the authorized team root, so a moved parent ID cannot redirect a write into another team.
    const anchoredPath = `${endpoint(storage.folderId)}:/${parts.map(encodeURIComponent).join("/")}`;
    const read = () =>
      Effect.gen(function* () {
        if ((yield* locateParent(false)) !== parentId) return yield* conflict();
        const item = yield* child(parentId, parts, false, false);
        if (!item.eTag || item.size === undefined || item.size < 0 || item.size > MAX_BYTES)
          return yield* unavailable("The document is missing a version or exceeds 64 KB.");
        const response = yield* download(yield* downloadUrl(item, storage));
        if (response.status !== 200)
          return yield* unavailable(
            "The document download expired or was redirected. Refresh and try again.",
          );
        const text = yield* readText(response);
        if ((yield* locateParent(false)) !== parentId) return yield* conflict();
        const latest = yield* child(parentId, parts, false, false);
        if (latest.id !== item.id || latest.eTag !== item.eTag) return yield* conflict();
        yield* verifyCurrent;
        return withChange({ path, etag: item.eTag, text }, item) satisfies TeamDocument;
      });
    if (command.action === "read-file") return yield* read();
    if (command.action === "list-versions" || command.action === "read-version") {
      // Versions are read by the item id just resolved from the team root, then the path is
      // resolved again, so a document moved or replaced meanwhile is refused.
      const item = yield* child(parentId, parts, false, false);
      const stillHere = Effect.gen(function* () {
        if ((yield* locateParent(false)) !== parentId) return yield* conflict();
        if ((yield* child(parentId, parts, false, false)).id !== item.id) return yield* conflict();
        yield* verifyCurrent;
      });
      const versions = `${endpoint(item.id)}/versions`;
      const toVersion = (version: typeof Version.Type): TeamDocumentVersion => {
        const change = changeOf(version);
        return { id: version.id, size: version.size ?? 0, ...(change ? { change } : {}) };
      };
      const invalidHistory = () => unavailable("Shared storage returned invalid version history.");
      if (command.action === "list-versions") {
        const response = yield* send(HttpClientRequest.get(versions));
        if (response.status !== 200)
          return yield* unavailable("This document's history could not be read. Try again.");
        const listed = yield* readText(response, 16 * MAX_BYTES).pipe(
          Effect.flatMap(decodeVersions),
          Effect.mapError(invalidHistory),
        );
        if (listed.value.some((version) => !versionId.test(version.id)))
          return yield* invalidHistory();
        const newest = listed.value
          .toSorted(
            (a, b) =>
              (Date.parse(b.lastModifiedDateTime ?? "") || 0) -
              (Date.parse(a.lastModifiedDateTime ?? "") || 0),
          )
          .slice(0, MAX_VERSIONS);
        yield* stillHere;
        return { history: { path, versions: newest.map(toVersion) } };
      }
      const at = `${versions}/${encodeURIComponent(command.versionId)}`;
      const found = yield* send(HttpClientRequest.get(at));
      // A version that is gone means the document changed, not that the team was lost.
      if (found.status === 404)
        return yield* new TeamsError({
          code: "conflict",
          message: "Shared storage no longer keeps that version. Reopen the history.",
        });
      if (found.status !== 200)
        return yield* unavailable("That version could not be read. Try again.");
      const version = yield* readText(found).pipe(
        Effect.flatMap(decodeVersion),
        Effect.mapError(invalidHistory),
      );
      if (version.id !== command.versionId) return yield* invalidHistory();
      if (version.size !== undefined && version.size > MAX_BYTES)
        return yield* unavailable("That version is larger than 64 KB, so Harness can't open it.");
      // Graph answers with the bytes or, usually, a redirect to a signed download on the team's
      // site. The bearer stays with Graph: the signed address is fetched without it.
      let content = yield* send(HttpClientRequest.get(`${at}/content`));
      if ([302, 303, 307].includes(content.status))
        content = yield* download(yield* signedUrl(content.headers.location ?? "", storage));
      if (content.status !== 200)
        return yield* unavailable("That version's download expired or was redirected. Try again.");
      const text = yield* readText(content);
      yield* stillHere;
      return { priorVersion: { path, version: toVersion(version), text } };
    }
    if (command.action === "delete-file") {
      const item = yield* child(parentId, parts, false, false);
      if (item.eTag !== command.etag) return yield* conflict();
      yield* verifyCurrent;
      const response = yield* send(
        HttpClientRequest.delete(anchoredPath).pipe(
          HttpClientRequest.setHeader("if-match", command.etag),
        ),
      );
      if (response.status === 409 || response.status === 412) return yield* conflict();
      if (response.status !== 204 && response.status !== 404)
        return yield* unavailable("The document could not be removed. Refresh before retrying.");
      yield* verifyCurrent;
      return null;
    }
    const text = command.action === "publish" ? formatTeamNote(command) : command.text;
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > MAX_BYTES)
      return yield* new TeamsError({
        code: "invalid_request",
        message: "Team documents must be smaller than 64 KB.",
      });
    if (command.action === "update-file") {
      const item = yield* child(parentId, parts, false, false);
      if (item.eTag !== command.etag) {
        const found = yield* read();
        if (found.text === text) return found;
        return yield* conflict();
      }
    }
    yield* verifyCurrent;
    const query = command.action === "publish" ? "?@microsoft.graph.conflictBehavior=fail" : "";
    const request = HttpClientRequest.put(`${anchoredPath}:/content${query}`).pipe(
      HttpClientRequest.bodyUint8Array(bytes, "text/markdown; charset=utf-8"),
    );
    const response = yield* send(
      command.action === "publish"
        ? request
        : request.pipe(HttpClientRequest.setHeader("if-match", command.etag)),
    );
    if ([409, 412].includes(response.status)) {
      // Recovers an upload whose success response was lost without replacing a different file.
      const found = yield* read();
      if (found.text === text) return found;
      return yield* conflict();
    }
    if (response.status !== 200 && response.status !== 201)
      return yield* unavailable(
        "The document was not confirmed saved. Keep your draft and retry the same operation.",
      );
    const saved = yield* checked(yield* parse(response), parentId, filename, false);
    if (!saved.eTag)
      return yield* unavailable(
        "Shared storage did not confirm a document version. Keep your draft and retry.",
      );
    if ((yield* locateParent(false)) !== parentId) return yield* conflict();
    yield* verifyCurrent;
    return withChange({ path, etag: saved.eTag, text }, saved) satisfies TeamDocument;
  }).pipe(
    Effect.map((result): DocumentResult =>
      result !== null && ("history" in result || "priorVersion" in result)
        ? { document: null, ...result }
        : { document: result },
    ),
  );

/** Enough of a document's start for the header `formatTeamNote` writes, whose fields are capped. */
const SUMMARY_BYTES = 4096;

/**
 * Reads the start of one document a list just found, for its title and description. Runs inside
 * the list's own authorized storage call: the item is resolved again from the team root and must
 * still be the listed item, version, and folder. Access failures from `send` fail the list; any
 * other problem leaves this document without a summary, so it can still be opened in full.
 */
export const summarizeDocument = (input: {
  storage: TeamStorage;
  file: { id: string; path: string; etag: string; parentId: string };
  send: Send;
}) =>
  Effect.gen(function* () {
    const { storage, file } = input;
    if (!documentPath.test(file.path)) return null;
    const http = yield* HttpClient.HttpClient;
    const root = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(storage.driveId)}/items/`;
    const response = yield* input.send(
      HttpClientRequest.get(
        `${root}${encodeURIComponent(storage.folderId)}:/${file.path.split("/").map(encodeURIComponent).join("/")}`,
      ),
    );
    const read = Effect.gen(function* () {
      if (response.status !== 200) return null;
      const item = yield* readText(response).pipe(Effect.flatMap(decodeItem));
      if (
        item.id !== file.id ||
        item.eTag !== file.etag ||
        item.parentReference.id !== file.parentId ||
        item.file === undefined ||
        item.folder !== undefined ||
        item.remoteItem !== undefined
      )
        return null;
      const url = yield* downloadUrl(item, storage);
      const download = yield* http.execute(
        HttpClientRequest.get(url.href).pipe(
          HttpClientRequest.setHeader("range", `bytes=0-${SUMMARY_BYTES - 1}`),
        ),
      );
      // A host that ignores the range answers 200 with the whole file; only its start is read.
      if (download.status !== 200 && download.status !== 206) return null;
      const chunks: Uint8Array[] = [];
      let size = 0;
      yield* download.stream.pipe(
        Stream.runForEachWhile((chunk) =>
          Effect.sync(() => {
            chunks.push(chunk);
            size += chunk.byteLength;
            return size < SUMMARY_BYTES;
          }),
        ),
      );
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const text = new TextDecoder().decode(bytes.subarray(0, SUMMARY_BYTES));
      // A cut-off final line could hold half a title or a broken character.
      return summarizeTeamNote(
        size >= SUMMARY_BYTES ? text.slice(0, Math.max(0, text.lastIndexOf("\n"))) : text,
      ) satisfies TeamDocumentSummary;
    });
    return yield* read.pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.orElseSucceed(() => null),
    );
  });
