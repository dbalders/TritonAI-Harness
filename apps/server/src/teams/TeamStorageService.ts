import * as NodeCrypto from "node:crypto";
import {
  type TeamStorageCommand,
  type TeamStorageStatus,
  type AccountStatus,
  ServerAccountError,
  TeamsError,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";
import { AccountService } from "../auth/AccountService.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as Microsoft from "../memory/sync/microsoftSignIn.ts";
import { executeDocument } from "./teamDocuments.ts";

const Guid = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/iu));
const OAuth = Schema.Struct({ clientId: Guid, tenantId: Guid });
const decodeOAuth = Schema.decodeUnknownOption(Schema.fromJsonString(OAuth));
const Item = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  eTag: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Schema.Int),
  parentReference: Schema.Struct({ id: Schema.String }),
  folder: Schema.optionalKey(Schema.Unknown),
  file: Schema.optionalKey(Schema.Unknown),
  remoteItem: Schema.optionalKey(Schema.Unknown),
});
const Page = Schema.Struct({
  value: Schema.Array(Item),
  "@odata.nextLink": Schema.optionalKey(Schema.String),
});
const encodeIdentity = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String))),
);
const decodePage = Schema.decodeUnknownEffect(Page);
const empty = (status: TeamStorageStatus["status"]): TeamStorageStatus => ({
  status,
  account: null,
  flowId: null,
  userCode: null,
  verificationUri: null,
  expiresAt: null,
  retryAfterSeconds: null,
  document: null,
  files: [],
});
const failure = (message: string) => new TeamsError({ code: "unavailable", message });
interface Connection {
  readonly sessionId: string;
  readonly signIn: Microsoft.MicrosoftSignIn["Service"];
}
export class TeamStorageService extends Context.Service<
  TeamStorageService,
  {
    readonly signOutAccount: (
      sessionId: string,
    ) => Effect.Effect<AccountStatus, ServerAccountError>;
    readonly execute: (
      sessionId: string,
      command: TeamStorageCommand,
    ) => Effect.Effect<TeamStorageStatus, TeamsError>;
  }
>()("t3/teams/TeamStorageService") {}

export const make = (config: Microsoft.MicrosoftOAuthConfig | null) =>
  Effect.gen(function* () {
    const account = yield* AccountService;
    const http = yield* HttpClient.HttpClient;
    const secrets = yield* ServerSecretStore;
    const connections = new Map<string, Connection>();
    const lanes = new Map<string, Semaphore.Semaphore>();
    const credentialIndex = (sessionId: string) =>
      `team-microsoft-index-${NodeCrypto.createHash("sha256").update(sessionId).digest("hex")}`;
    const Index = Schema.Array(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))).check(
      Schema.isMaxLength(64),
    );
    const readIndex = (sessionId: string) =>
      secrets.get(credentialIndex(sessionId)).pipe(
        Effect.flatMap((value) =>
          Option.isSome(value)
            ? Schema.decodeUnknownEffect(Schema.fromJsonString(Index))(
                new TextDecoder().decode(value.value),
              )
            : Effect.succeed([] as readonly string[]),
        ),
        Effect.mapError(() => failure("Microsoft connection records could not be read securely.")),
      );
    const getLane = (sessionId: string) => {
      let lane = lanes.get(sessionId);
      if (!lane) {
        lane = Semaphore.makeUnsafe(1);
        lanes.set(sessionId, lane);
      }
      return lane;
    };
    const signOutAccount = Effect.fn("TeamStorageService.signOutAccount")(function* (
      sessionId: string,
    ) {
      // Revoke campus access first; in-flight file operations then fail their membership readback.
      const status = yield* account.signOut(sessionId);
      yield* getLane(sessionId)
        .withPermit(
          Effect.gen(function* () {
            for (const [key, connection] of connections) {
              if (connection.sessionId !== sessionId) continue;
              yield* connection.signIn.signOut;
              connections.delete(key);
            }
            // The index also covers credentials restored after a server restart.
            for (const key of yield* readIndex(sessionId))
              yield* secrets.remove(`team-microsoft-${key}`);
            yield* secrets.remove(credentialIndex(sessionId));
          }),
        )
        .pipe(
          Effect.mapError(
            () =>
              new ServerAccountError({
                code: "storage_error",
                message:
                  "Your campus account is signed out, but the Microsoft connection could not be fully cleared. Retry sign-out.",
              }),
          ),
        );
      return status;
    });
    const execute = Effect.fn("TeamStorageService.execute")(function* (
      sessionId: string,
      command: TeamStorageCommand,
    ) {
      return yield* getLane(sessionId).withPermit(
        Effect.gen(function* () {
          const signedIn = yield* account
            .getStatus(sessionId)
            .pipe(
              Effect.mapError(() => failure("Your UC San Diego account could not be verified.")),
            );
          if (signedIn.status !== "signed-in" || !signedIn.profile)
            return yield* new TeamsError({
              code: "sign_in_required",
              message: "Sign in with UC San Diego to open shared storage.",
            });
          const profile = signedIn.profile;
          const result = yield* account.teams(sessionId, { action: "get", teamId: command.teamId });
          const team = result.team;
          // Storage is used only when bound to the exact team the caller asked for.
          if (team && team.id !== command.teamId)
            return yield* new TeamsError({
              code: "not_found",
              message: "This team is not available to your account.",
            });
          if (!team || !team.storage || team.state !== "ready")
            return yield* failure("The team's private folder is not ready.");
          const storage = team.storage;
          if (!config || config.tenantId.toLowerCase() !== storage.tenantId.toLowerCase())
            return empty("not-configured");
          const key = NodeCrypto.createHash("sha256")
            .update(
              encodeIdentity([
                signedIn.serviceUrl,
                sessionId,
                profile.issuer,
                profile.subject,
                config.clientId,
                storage.tenantId,
              ]),
            )
            .digest("hex");
          let connection = connections.get(key);
          if (!connection) {
            const keys = yield* readIndex(sessionId);
            if (!keys.includes(key)) {
              if (keys.length >= 64)
                return yield* failure(
                  "Sign out to clear old Microsoft connections before reconnecting.",
                );
              const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Index))([
                ...keys,
                key,
              ]).pipe(
                Effect.mapError(() =>
                  failure("The Microsoft connection could not be saved securely."),
                ),
              );
              yield* secrets
                .set(credentialIndex(sessionId), new TextEncoder().encode(encoded))
                .pipe(
                  Effect.mapError(() =>
                    failure("The Microsoft connection could not be saved securely."),
                  ),
                );
            }
            const signIn = yield* Microsoft.make(config, {
              secretName: `team-microsoft-${key}`,
              scopes: "Sites.Selected User.Read offline_access",
              requiredAccount: { email: profile.email, tenantId: storage.tenantId },
            }).pipe(
              Effect.provideService(HttpClient.HttpClient, http),
              Effect.provideService(ServerSecretStore, secrets),
            );
            connection = { signIn, sessionId };
            connections.set(key, connection);
          }
          const signIn = connection.signIn;
          const verifyCurrent = Effect.gen(function* () {
            const current = yield* account
              .getStatus(sessionId)
              .pipe(Effect.mapError(() => failure("Your account could not be verified.")));
            if (
              current.status !== "signed-in" ||
              current.profile?.issuer !== profile.issuer ||
              current.profile.subject !== profile.subject
            )
              return yield* new TeamsError({
                code: "sign_in_required",
                message: "Your account changed. Reopen this team.",
              });
            const refreshed = yield* account.teams(sessionId, {
              action: "get",
              teamId: command.teamId,
            });
            if (
              refreshed.team?.id !== team.id ||
              refreshed.team.revision !== team.revision ||
              refreshed.team.state !== "ready" ||
              refreshed.team.storage?.driveId !== storage.driveId ||
              refreshed.team.storage.folderId !== storage.folderId
            )
              return yield* new TeamsError({
                code: "conflict",
                message: "Team access changed. Refresh before continuing.",
              });
          });
          const action = Effect.gen(function* () {
            if (command.action === "disconnect") {
              yield* signIn.signOut;
              return empty("disconnected");
            }
            if (command.action === "connect") {
              const flow = yield* signIn.start(verifyCurrent);
              if (flow.kind === "connected") {
                const who = yield* signIn.account;
                return { ...empty("connected"), account: who?.account ?? null };
              }
              // The renderer only opens this fixed Microsoft origin; unexpected OAuth URLs are rejected.
              if (
                ![
                  "https://microsoft.com/devicelogin",
                  "https://www.microsoft.com/devicelogin",
                ].includes(flow.verificationUri)
              )
                return yield* failure("Microsoft returned an unexpected sign-in address.");
              return { ...empty("pending"), ...flow, retryAfterSeconds: flow.intervalSeconds };
            }
            if (command.action === "poll") {
              const poll = yield* signIn.pollDeviceCode(command.flowId, verifyCurrent);
              if (poll.state === "pending")
                return {
                  ...empty("pending"),
                  flowId: command.flowId,
                  retryAfterSeconds: poll.retryAfterSeconds,
                };
              if (poll.state !== "connected")
                return yield* failure(poll.message ?? "Microsoft sign-in expired. Try again.");
            }
            const who = yield* signIn.account;
            if (!who?.accountId) return empty("disconnected");
            const connected = { ...empty("connected"), account: who.account };
            const send = (request: HttpClientRequest.HttpClientRequest) =>
              Effect.gen(function* () {
                yield* verifyCurrent;
                const token = yield* signIn.accessToken.pipe(
                  Effect.mapError((error) =>
                    error._tag === "MemorySyncSignInRequired"
                      ? new TeamsError({
                          code: "sign_in_required",
                          message: "Reconnect Microsoft to continue.",
                        })
                      : failure("Microsoft could not verify the connection. Try again."),
                  ),
                );
                const response = yield* http
                  .execute(request.pipe(HttpClientRequest.bearerToken(token)))
                  .pipe(
                    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
                    Effect.mapError(() => failure("Shared storage could not be reached.")),
                  );
                if (response.status === 401) {
                  yield* signIn.invalidateAccessToken;
                  return yield* new TeamsError({
                    code: "sign_in_required",
                    message: "Reconnect Microsoft to continue.",
                  });
                }
                return response;
              });
            if (
              command.action === "publish" ||
              command.action === "read-file" ||
              command.action === "update-file" ||
              command.action === "delete-file"
            ) {
              const actorId = NodeCrypto.createHash("sha256")
                .update(encodeIdentity([profile.issuer, profile.subject]))
                .digest("base64url");
              const document = yield* executeDocument({
                command,
                storage,
                actorId,
                canWrite: team.role !== "reader" || team.canManage,
                canManage: team.canManage,
                send,
                verifyCurrent,
              }).pipe(Effect.provideService(HttpClient.HttpClient, http));
              return { ...connected, document };
            }
            if (command.action !== "list-files") return connected;
            const files: TeamStorageStatus["files"][number][] = [];
            const queue = [{ id: storage.folderId, path: "", depth: 0 }];
            const visited = new Set<string>();
            const root = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(storage.driveId)}/items/`;
            const folderEndpoint = (path: string) =>
              path
                ? `${root}${encodeURIComponent(storage.folderId)}:/${path.split("/").map(encodeURIComponent).join("/")}`
                : `${root}${encodeURIComponent(storage.folderId)}`;
            const verifyFolder = (parent: { id: string; path: string }) =>
              Effect.gen(function* () {
                if (!parent.path) return;
                const response = yield* send(
                  HttpClientRequest.get(
                    `${folderEndpoint(parent.path)}?$select=id,name,parentReference,folder,remoteItem`,
                  ),
                );
                if (response.status !== 200)
                  return yield* failure(
                    "A shared folder moved. Refresh the team before continuing.",
                  );
                const item = yield* response.json.pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(Item)),
                  Effect.mapError(() =>
                    failure("Shared storage returned invalid folder metadata."),
                  ),
                );
                if (
                  item.id !== parent.id ||
                  item.folder === undefined ||
                  item.remoteItem !== undefined
                )
                  return yield* failure(
                    "A shared folder moved. Refresh the team before continuing.",
                  );
              });
            for (let cursor = 0; cursor < queue.length; cursor++) {
              const parent = queue[cursor]!;
              if (visited.has(parent.id) || parent.depth > 8 || visited.size > 1000)
                return yield* failure("This team's shared folder is too large to list safely.");
              visited.add(parent.id);
              yield* verifyFolder(parent);
              const endpoint = `${folderEndpoint(parent.path)}${parent.path ? ":" : ""}/children`;
              let url: string | undefined =
                `${endpoint}?$select=id,name,eTag,size,folder,file,parentReference,remoteItem&$top=200`;
              const pages = new Set<string>();
              while (url) {
                const next = new URL(url);
                if (
                  next.origin !== "https://graph.microsoft.com" ||
                  next.pathname !== new URL(endpoint).pathname ||
                  next.username ||
                  next.password ||
                  pages.has(url)
                )
                  return yield* failure("Shared storage returned an invalid continuation.");
                pages.add(url);
                if (pages.size > 20)
                  return yield* failure("This team has too many shared files to display.");
                yield* verifyCurrent;
                const response: HttpClientResponse.HttpClientResponse = yield* send(
                  HttpClientRequest.get(url),
                );
                if (response.status !== 200)
                  return yield* failure(
                    "Shared storage access could not be verified. Refresh your team membership.",
                  );
                const page: typeof Page.Type = yield* response.json.pipe(
                  Effect.flatMap(decodePage),
                  Effect.mapError(() => failure("Shared storage returned an invalid file list.")),
                );
                for (const item of page.value) {
                  if (
                    item.parentReference.id !== parent.id ||
                    item.remoteItem !== undefined ||
                    /[\u0000-\u001f\\/]/u.test(item.name) ||
                    [".", ".."].includes(item.name)
                  )
                    return yield* failure("Shared storage contained an unexpected item.");
                  const path = parent.path ? `${parent.path}/${item.name}` : item.name;
                  if (item.folder !== undefined)
                    queue.push({ id: item.id, path, depth: parent.depth + 1 });
                  else if (item.file !== undefined && item.eTag)
                    files.push({ id: item.id, path, etag: item.eTag, size: item.size ?? 0 });
                  if (files.length + queue.length > 4000)
                    return yield* failure("This team has too many shared files to display.");
                }
                url = page["@odata.nextLink"];
              }
            }
            for (const parent of queue) yield* verifyFolder(parent);
            yield* verifyCurrent;
            return { ...connected, files };
          });
          return yield* action.pipe(
            Effect.tap(() => verifyCurrent),
            Effect.catchTags({
              MemorySyncFailure: (error) => Effect.fail(failure(error.message)),
            }),
            Effect.timeout("60 seconds"),
            Effect.catchTag("TimeoutError", () =>
              Effect.fail(failure("Shared storage timed out. Try again.")),
            ),
          );
        }),
      );
    });
    return TeamStorageService.of({ execute, signOutAccount });
  });

export const layer = Layer.effect(
  TeamStorageService,
  Effect.gen(function* () {
    const json = yield* Config.String("TRITONAI_TEAMS_MICROSOFT_OAUTH_JSON").pipe(
      Config.withDefault(""),
    );
    const config = decodeOAuth(json);
    return yield* make(config._tag === "Some" ? config.value : null);
  }),
);
