/**
 * The Microsoft Graph calls memory sync makes against the user's OneDrive.
 *
 * Items are addressed by id once found, so a renamed parent never redirects a
 * write. Writes are conditional: an upload either creates a file that must not
 * exist yet or replaces the exact version sync last saw (`If-Match`), and a
 * delete only removes that version. OneDrive rejects anything else with 409 or
 * 412, which sync treats as "look again next pass".
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { MemorySyncFailure, MicrosoftSignIn } from "./microsoftSignIn.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";
const REQUEST_TIMEOUT = Duration.seconds(60);
/** Simple uploads are limited to 4 MB; larger files are skipped. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export const DriveItem = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
  eTag: Schema.optionalKey(Schema.String),
  file: Schema.optionalKey(Schema.Unknown),
  folder: Schema.optionalKey(Schema.Unknown),
  deleted: Schema.optionalKey(Schema.Unknown),
  parentReference: Schema.optionalKey(Schema.Struct({ id: Schema.optionalKey(Schema.String) })),
});
export type DriveItem = typeof DriveItem.Type;
const decodeDriveItem = Schema.decodeUnknownEffect(DriveItem);
const DeltaPage = Schema.Struct({
  value: Schema.Array(DriveItem),
  "@odata.nextLink": Schema.optionalKey(Schema.String),
  "@odata.deltaLink": Schema.optionalKey(Schema.String),
});
const decodeDeltaPage = Schema.decodeUnknownEffect(DeltaPage);
const Identity = Schema.Struct({ id: Schema.String });
const decodeIdentity = Schema.decodeUnknownEffect(Identity);

interface GraphResponse {
  readonly status: number;
  readonly body: Uint8Array;
}

function json(response: GraphResponse): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(response.body));
  } catch {
    return null;
  }
}

function graphError(response: GraphResponse, action: string) {
  const code = (json(response) as { error?: { code?: string } } | null)?.error?.code;
  if (response.status === 429 || response.status === 503) {
    return new MemorySyncFailure({ message: "OneDrive is busy. Memory will sync again shortly." });
  }
  return new MemorySyncFailure({
    message: `OneDrive could not ${action} (${response.status}${code ? ` ${code}` : ""}).`,
  });
}

const encodeName = (name: string) => encodeURIComponent(name);

export const makeOneDrive = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const signIn = yield* MicrosoftSignIn;

  const sendOnce = (build: (token: string) => HttpClientRequest.HttpClientRequest) =>
    signIn.accessToken.pipe(
      Effect.flatMap((token) =>
        httpClient.execute(build(token)).pipe(
          Effect.flatMap((response) =>
            response.arrayBuffer.pipe(
              Effect.map((buffer) => ({ status: response.status, body: new Uint8Array(buffer) })),
            ),
          ),
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.mapError(
            () =>
              new MemorySyncFailure({
                message: "Could not reach OneDrive. Check your connection.",
              }),
          ),
        ),
      ),
    );

  /** Sends a request, signing in again once if Graph rejects the token. */
  const send = (build: (token: string) => HttpClientRequest.HttpClientRequest) =>
    sendOnce(build).pipe(
      Effect.flatMap((response) =>
        response.status === 401
          ? signIn.invalidateAccessToken.pipe(Effect.andThen(sendOnce(build)))
          : Effect.succeed(response),
      ),
    );

  const authorized =
    (request: HttpClientRequest.HttpClientRequest) =>
    (token: string): HttpClientRequest.HttpClientRequest =>
      request.pipe(HttpClientRequest.bearerToken(token));

  const getIdentity = (url: string, action: string) =>
    Effect.gen(function* () {
      const response = yield* send(authorized(HttpClientRequest.get(`${GRAPH}${url}`)));
      if (response.status !== 200) return yield* graphError(response, action);
      return yield* decodeIdentity(json(response)).pipe(
        Effect.mapError(
          () =>
            new MemorySyncFailure({
              message: `OneDrive returned an unexpected ${action} response.`,
            }),
        ),
      );
    });

  const account = getIdentity("/me?$select=id", "account");
  const drive = getIdentity("/me/drive?$select=id", "drive");

  /** A child folder's id, creating it if needed. Never renames on conflict. */
  const ensureFolder = (parentId: string | null, name: string) =>
    Effect.gen(function* () {
      const parentPath = parentId === null ? "/me/drive/root" : `/me/drive/items/${parentId}`;
      const lookup = send(
        authorized(
          HttpClientRequest.get(`${GRAPH}${parentPath}:/${encodeName(name)}?$select=id,folder`),
        ),
      );
      const found = yield* lookup;
      if (found.status === 200) return (yield* decodeDriveItem(json(found)).pipe(Effect.orDie)).id;
      if (found.status !== 404) return yield* graphError(found, "open a folder");
      const created = yield* send(
        authorized(
          HttpClientRequest.post(`${GRAPH}${parentPath}/children`).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              name,
              folder: {},
              "@microsoft.graph.conflictBehavior": "fail",
            }),
          ),
        ),
      );
      if (created.status === 201 || created.status === 200) {
        return (yield* decodeDriveItem(json(created)).pipe(Effect.orDie)).id;
      }
      // Another computer created it first.
      if (created.status === 409) {
        const again = yield* lookup;
        if (again.status === 200)
          return (yield* decodeDriveItem(json(again)).pipe(Effect.orDie)).id;
      }
      return yield* graphError(created, "create a folder");
    });

  /** Resolves `a/b/c` under the drive root, creating folders as needed. */
  const ensureFolderPath = (segments: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      let parentId: string | null = null;
      for (const name of segments) parentId = yield* ensureFolder(parentId, name);
      if (parentId === null)
        return yield* new MemorySyncFailure({ message: "No cloud folder named." });
      return parentId;
    });

  type DeltaResult =
    | {
        readonly kind: "changes";
        readonly items: ReadonlyArray<DriveItem>;
        readonly deltaLink: string;
      }
    | { readonly kind: "resync" };

  /** Every change below `folderId` since `deltaLink`, or its whole subtree without one. */
  const delta = (folderId: string, deltaLink: string | null) =>
    Effect.gen(function* () {
      const items: DriveItem[] = [];
      let url = deltaLink ?? `${GRAPH}/me/drive/items/${folderId}/delta`;
      for (;;) {
        const response = yield* send(authorized(HttpClientRequest.get(url)));
        // The cursor is too old, or the folder is gone: start over from a full listing.
        if (response.status === 410 || response.status === 404)
          return { kind: "resync" } as DeltaResult;
        if (response.status !== 200) return yield* graphError(response, "list changes");
        const page = yield* decodeDeltaPage(json(response)).pipe(
          Effect.mapError(
            () =>
              new MemorySyncFailure({ message: "OneDrive returned an unexpected change list." }),
          ),
        );
        items.push(...page.value);
        if (page["@odata.nextLink"]) {
          url = page["@odata.nextLink"];
          continue;
        }
        if (!page["@odata.deltaLink"]) {
          return yield* new MemorySyncFailure({
            message: "OneDrive did not return a change cursor.",
          });
        }
        return { kind: "changes", items, deltaLink: page["@odata.deltaLink"] } as DeltaResult;
      }
    });

  type WriteResult =
    | { readonly kind: "ok"; readonly item: DriveItem }
    | { readonly kind: "conflict" };

  /** Creates `name` under `parentId` (`ifMatch` null) or replaces the version `ifMatch` names. */
  const upload = (parentId: string, name: string, content: Uint8Array, ifMatch: string | null) =>
    Effect.gen(function* () {
      const query = ifMatch === null ? "?@microsoft.graph.conflictBehavior=fail" : "";
      const response = yield* send((token) => {
        const request = HttpClientRequest.put(
          `${GRAPH}/me/drive/items/${parentId}:/${encodeName(name)}:/content${query}`,
        ).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.bodyUint8Array(content, "application/octet-stream"),
        );
        return ifMatch === null
          ? request
          : request.pipe(HttpClientRequest.setHeader("if-match", ifMatch));
      });
      if (response.status === 200 || response.status === 201) {
        const item = yield* decodeDriveItem(json(response)).pipe(Effect.orDie);
        return { kind: "ok", item } as WriteResult;
      }
      if (response.status === 409 || response.status === 412)
        return { kind: "conflict" } as WriteResult;
      return yield* graphError(response, "upload a file");
    });

  const download = (itemId: string) =>
    send(authorized(HttpClientRequest.get(`${GRAPH}/me/drive/items/${itemId}/content`))).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? Effect.succeed(response.body)
          : Effect.fail(graphError(response, "download a file")),
      ),
    );

  /** Deletes only the version `ifMatch` names. A file already gone counts as deleted. */
  const remove = (itemId: string, ifMatch: string) =>
    send((token) =>
      HttpClientRequest.delete(`${GRAPH}/me/drive/items/${itemId}`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeader("if-match", ifMatch),
      ),
    ).pipe(
      Effect.flatMap((response) =>
        response.status === 204 || response.status === 404
          ? Effect.succeed("deleted" as const)
          : response.status === 412 || response.status === 409
            ? Effect.succeed("conflict" as const)
            : Effect.fail(graphError(response, "delete a file")),
      ),
    );

  return { account, drive, ensureFolder, ensureFolderPath, delta, upload, download, remove };
});

export type OneDrive = Effect.Success<typeof makeOneDrive>;
