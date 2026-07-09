import * as NodeServices from "@effect/platform-node/NodeServices";
import { MicrosoftGraphConnectionError } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as MicrosoftGraphConnection from "./MicrosoftGraphConnection.ts";

type GraphHttpRequest = Parameters<
  MicrosoftGraphConnection.MicrosoftGraphHttpClientShape["requestJson"]
>[0];

interface FakeGraphResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly json: unknown;
}

const graphTokenUrl = `https://login.microsoftonline.com/${MicrosoftGraphConnection.MicrosoftGraphTenantId}/oauth2/v2.0/token`;
const graphDeviceCodeUrl = `https://login.microsoftonline.com/${MicrosoftGraphConnection.MicrosoftGraphTenantId}/oauth2/v2.0/devicecode`;

function makeGraphEffectLayer(
  handler: (
    request: GraphHttpRequest,
  ) => Effect.Effect<FakeGraphResponse, MicrosoftGraphConnectionError>,
) {
  const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-msgraph-test-" });
  const secretLayer = ServerSecretStore.layer.pipe(Layer.provide(configLayer));
  const httpLayer = Layer.succeed(MicrosoftGraphConnection.MicrosoftGraphHttpClient, {
    requestJson: handler,
  });
  const graphLayer = MicrosoftGraphConnection.layer.pipe(
    Layer.provide(httpLayer),
    Layer.provide(secretLayer),
  );
  return Layer.merge(graphLayer, secretLayer);
}

function makeGraphLayer(handler: (request: GraphHttpRequest) => FakeGraphResponse) {
  return makeGraphEffectLayer((request) => Effect.sync(() => handler(request)));
}

function makeGraphEffectLayerWithSecretStore(
  handler: (
    request: GraphHttpRequest,
  ) => Effect.Effect<FakeGraphResponse, MicrosoftGraphConnectionError>,
  secretStore: ServerSecretStore.ServerSecretStore["Service"],
) {
  const secretLayer = Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore);
  const httpLayer = Layer.succeed(MicrosoftGraphConnection.MicrosoftGraphHttpClient, {
    requestJson: handler,
  });
  const graphLayer = MicrosoftGraphConnection.layer.pipe(
    Layer.provide(httpLayer),
    Layer.provide(secretLayer),
  );
  return Layer.merge(graphLayer, secretLayer);
}

function deviceCodeResponse() {
  return {
    status: 200,
    ok: true,
    json: {
      device_code: "device-code-secret",
      user_code: "ABCD-EFGH",
      verification_uri: "https://microsoft.com/devicelogin",
      expires_in: 900,
      interval: 1,
      message: "Use this code.",
    },
  } satisfies FakeGraphResponse;
}

function tokenResponse(input?: {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresIn?: number;
}) {
  return {
    status: 200,
    ok: true,
    json: {
      token_type: "Bearer",
      access_token: input?.accessToken ?? "access-token",
      refresh_token: input?.refreshToken ?? "refresh-token",
      expires_in: input?.expiresIn ?? 3600,
      scope: "User.Read Mail.Read Calendars.Read offline_access",
    },
  } satisfies FakeGraphResponse;
}

function accountResponse() {
  return {
    status: 200,
    ok: true,
    json: {
      id: "user-id",
      displayName: "David Balderston",
      mail: "david@example.com",
      userPrincipalName: "david@example.com",
    },
  } satisfies FakeGraphResponse;
}

it.layer(NodeServices.layer)("MicrosoftGraphConnection", (it) => {
  it.effect("completes device-code sign-in and exposes only redacted status", () => {
    let tokenPollCount = 0;
    return Effect.gen(function* () {
      const service = yield* MicrosoftGraphConnection.MicrosoftGraphConnection;
      const secrets = yield* ServerSecretStore.ServerSecretStore;

      const start = yield* service.startSignIn();
      assert.equal(start.clientId, MicrosoftGraphConnection.MicrosoftGraphClientId);
      assert.equal(start.tenantId, MicrosoftGraphConnection.MicrosoftGraphTenantId);
      assert.equal(start.userCode, "ABCD-EFGH");
      assert.equal("deviceCode" in start, false);

      const pending = yield* service.pollSignIn({ flowId: start.flowId });
      assert.equal(pending.state, "pending");
      assert.equal(pending.status.state, "not_connected");

      const connected = yield* service.pollSignIn({ flowId: start.flowId });
      assert.equal(connected.state, "connected");
      assert.equal(connected.status.state, "connected");
      assert.equal(connected.status.account?.userPrincipalName, "david@example.com");
      assert.deepStrictEqual(connected.status.grantedScopes, [
        "User.Read",
        "Mail.Read",
        "Calendars.Read",
        "offline_access",
      ]);
      assert.equal("accessToken" in connected.status, false);
      assert.equal("refreshToken" in connected.status, false);

      const encoded = yield* secrets.get(
        MicrosoftGraphConnection.MICROSOFT_GRAPH_CREDENTIAL_SECRET_NAME,
      );
      assert.isTrue(Option.isSome(encoded));
      if (Option.isSome(encoded)) {
        const persisted = new TextDecoder().decode(encoded.value);
        assert.include(persisted, "refresh-token");
        assert.notInclude(persisted, "access-token");
        assert.notInclude(persisted, "device-code-secret");
      }
    }).pipe(
      Effect.provide(
        makeGraphLayer((request) => {
          if (request.url === graphDeviceCodeUrl) {
            assert.equal(request.form?.client_id, MicrosoftGraphConnection.MicrosoftGraphClientId);
            assert.equal(request.form?.scope, "User.Read Mail.Read Calendars.Read offline_access");
            return deviceCodeResponse();
          }

          if (request.url === graphTokenUrl && request.form?.grant_type?.includes("device_code")) {
            const currentTokenPoll = tokenPollCount;
            tokenPollCount += 1;
            if (currentTokenPoll === 0) {
              return {
                status: 400,
                ok: false,
                json: {
                  error: "authorization_pending",
                  error_description: "Authorization pending.",
                },
              };
            }
            assert.equal(request.form.device_code, "device-code-secret");
            return tokenResponse();
          }

          if (request.url.startsWith("https://graph.microsoft.com/v1.0/me?")) {
            assert.equal(request.headers?.authorization, "Bearer access-token");
            return accountResponse();
          }

          throw new Error(`Unexpected request: ${request.url}`);
        }),
      ),
    );
  });

  it.effect("refreshes before server-side Graph requests using the stored refresh token", () => {
    const requests: GraphHttpRequest[] = [];
    return Effect.gen(function* () {
      const service = yield* MicrosoftGraphConnection.MicrosoftGraphConnection;

      const start = yield* service.startSignIn();
      const connected = yield* service.pollSignIn({ flowId: start.flowId });
      assert.equal(connected.state, "connected");

      const messages = yield* service.requestGraphJson({
        path: "/v1.0/me/messages?$top=1",
      });

      assert.deepStrictEqual(messages, { value: [{ id: "message-1" }] });
      assert.deepStrictEqual(
        requests.map((request) =>
          request.url === graphTokenUrl && request.form?.grant_type === "refresh_token"
            ? "refresh"
            : request.url,
        ),
        [
          graphDeviceCodeUrl,
          graphTokenUrl,
          "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName",
          "refresh",
          "https://graph.microsoft.com/v1.0/me/messages?$top=1",
        ],
      );
    }).pipe(
      Effect.provide(
        makeGraphLayer((request) => {
          requests.push(request);
          if (request.url === graphDeviceCodeUrl) {
            return deviceCodeResponse();
          }
          if (request.url === graphTokenUrl && request.form?.grant_type?.includes("device_code")) {
            return tokenResponse({
              accessToken: "soon-expiring-access-token",
              refreshToken: "refresh-token",
              expiresIn: 60,
            });
          }
          if (request.url === graphTokenUrl && request.form?.grant_type === "refresh_token") {
            assert.equal(request.form.refresh_token, "refresh-token");
            return tokenResponse({
              accessToken: "refreshed-access-token",
              refreshToken: "new-refresh-token",
            });
          }
          if (request.url.startsWith("https://graph.microsoft.com/v1.0/me?")) {
            assert.equal(request.headers?.authorization, "Bearer soon-expiring-access-token");
            return accountResponse();
          }
          if (request.url === "https://graph.microsoft.com/v1.0/me/messages?$top=1") {
            assert.equal(request.headers?.authorization, "Bearer refreshed-access-token");
            return { status: 200, ok: true, json: { value: [{ id: "message-1" }] } };
          }
          throw new Error(`Unexpected request: ${request.url}`);
        }),
      ),
    );
  });

  it.effect("does not advance the in-memory access token when refresh persistence fails", () => {
    let storedCredential: Uint8Array | null = null;
    let setCount = 0;
    const secretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeed(storedCredential ? Option.some(storedCredential) : Option.none()),
      set: (_name, value) => {
        setCount += 1;
        if (setCount === 2) {
          return Effect.fail(
            new ServerSecretStore.SecretStorePersistError({
              resource: "secret microsoft-graph-refresh-token-cache",
              cause: new Error("simulated persist failure"),
            }),
          );
        }
        storedCredential = value;
        return Effect.void;
      },
      create: (_name, value) =>
        Effect.sync(() => {
          storedCredential = value;
        }),
      getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes)),
      remove: () =>
        Effect.sync(() => {
          storedCredential = null;
        }),
    });

    return Effect.gen(function* () {
      const service = yield* MicrosoftGraphConnection.MicrosoftGraphConnection;
      const secrets = yield* ServerSecretStore.ServerSecretStore;

      const start = yield* service.startSignIn();
      const connected = yield* service.pollSignIn({ flowId: start.flowId });
      assert.equal(connected.state, "connected");
      assert.isString(connected.status.accessTokenExpiresAt);
      const initialAccessTokenExpiresAt = connected.status.accessTokenExpiresAt;

      const error = yield* service
        .requestGraphJson({
          path: "/v1.0/me/messages?$top=1",
        })
        .pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => null,
          }),
        );
      assert.isNotNull(error);
      assert.equal(error?.code, "storage_error");

      const status = yield* service.getStatus();
      assert.equal(status.accessTokenExpiresAt, initialAccessTokenExpiresAt);

      const encoded = yield* secrets.get(
        MicrosoftGraphConnection.MICROSOFT_GRAPH_CREDENTIAL_SECRET_NAME,
      );
      assert.isTrue(Option.isSome(encoded));
      if (Option.isSome(encoded)) {
        const persisted = new TextDecoder().decode(encoded.value);
        assert.include(persisted, "refresh-token");
        assert.notInclude(persisted, "new-refresh-token");
      }
    }).pipe(
      Effect.provide(
        makeGraphEffectLayerWithSecretStore(
          (request) =>
            Effect.sync(() => {
              if (request.url === graphDeviceCodeUrl) {
                return deviceCodeResponse();
              }
              if (
                request.url === graphTokenUrl &&
                request.form?.grant_type?.includes("device_code")
              ) {
                return tokenResponse({
                  accessToken: "soon-expiring-access-token",
                  refreshToken: "refresh-token",
                  expiresIn: 60,
                });
              }
              if (request.url === graphTokenUrl && request.form?.grant_type === "refresh_token") {
                assert.equal(request.form.refresh_token, "refresh-token");
                return tokenResponse({
                  accessToken: "refreshed-access-token",
                  refreshToken: "new-refresh-token",
                });
              }
              if (request.url.startsWith("https://graph.microsoft.com/v1.0/me?")) {
                assert.equal(request.headers?.authorization, "Bearer soon-expiring-access-token");
                return accountResponse();
              }
              throw new Error(`Unexpected request: ${request.url}`);
            }),
          secretStore,
        ),
      ),
    );
  });

  it.effect("disconnects by removing the saved server-side credential", () =>
    Effect.gen(function* () {
      const service = yield* MicrosoftGraphConnection.MicrosoftGraphConnection;
      const secrets = yield* ServerSecretStore.ServerSecretStore;

      const start = yield* service.startSignIn();
      const connected = yield* service.pollSignIn({ flowId: start.flowId });
      assert.equal(connected.status.state, "connected");

      const disconnected = yield* service.disconnect();
      assert.equal(disconnected.status.state, "not_connected");
      const status = yield* service.getStatus();
      assert.equal(status.state, "not_connected");
      assert.isTrue(
        Option.isNone(
          yield* secrets.get(MicrosoftGraphConnection.MICROSOFT_GRAPH_CREDENTIAL_SECRET_NAME),
        ),
      );
    }).pipe(
      Effect.provide(
        makeGraphLayer((request) => {
          if (request.url === graphDeviceCodeUrl) return deviceCodeResponse();
          if (request.url === graphTokenUrl) return tokenResponse();
          if (request.url.startsWith("https://graph.microsoft.com/v1.0/me?")) {
            return accountResponse();
          }
          throw new Error(`Unexpected request: ${request.url}`);
        }),
      ),
    ),
  );

  it.effect("keeps token-bearing HTTP causes out of public errors", () =>
    Effect.gen(function* () {
      const service = yield* MicrosoftGraphConnection.MicrosoftGraphConnection;

      const error = yield* Effect.flip(service.startSignIn());
      assert.equal(error._tag, "MicrosoftGraphConnectionError");
      assert.equal(error.code, "invalid_response");
      assert.equal(error.cause, undefined);
    }).pipe(
      Effect.provide(
        makeGraphEffectLayer(() =>
          Effect.fail(
            new MicrosoftGraphConnectionError({
              code: "invalid_response",
              message: "Microsoft Graph HTTP request failed.",
              cause: {
                form: {
                  refresh_token: "refresh-token-secret",
                  device_code: "device-code-secret",
                },
                headers: {
                  authorization: "Bearer access-token-secret",
                },
              },
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("rejects non-root-relative internal Graph paths", () =>
    Effect.gen(function* () {
      const service = yield* MicrosoftGraphConnection.MicrosoftGraphConnection;
      const rejected = yield* service
        .requestGraphJson({ path: "//example.test/v1.0/me" as `/${string}` })
        .pipe(
          Effect.match({
            onFailure: (error) => {
              assert.equal(error.code, "graph_error");
              assert.match(error.message, /root-relative/);
              return true;
            },
            onSuccess: () => false,
          }),
        );
      assert.equal(rejected, true);
    }).pipe(Effect.provide(makeGraphLayer(() => deviceCodeResponse()))),
  );
});
