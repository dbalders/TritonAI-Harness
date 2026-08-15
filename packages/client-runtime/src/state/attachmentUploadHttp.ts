import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

const ATTACHMENT_UPLOAD_TIMEOUT_MS = 120_000;
const ATTACHMENT_DELETE_TIMEOUT_MS = 30_000;

export const uploadEnvironmentAttachment = Effect.fn(
  "clientRuntime.state.uploadEnvironmentAttachment",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly file: File;
}) {
  const requestPath = `/api/orchestration/threads/${input.threadId}/attachments`;
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, requestPath);
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "POST",
    requestUrl,
    signer,
  );
  const payload = new FormData();
  payload.append("file", input.file, input.file.name);

  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    ATTACHMENT_UPLOAD_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.orchestration.uploadAttachment({
        params: { threadId: input.threadId },
        headers,
        payload,
      }),
    ),
  );
});

export const deleteEnvironmentAttachment = Effect.fn(
  "clientRuntime.state.deleteEnvironmentAttachment",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly attachmentId: string;
}) {
  const requestPath = `/api/orchestration/threads/${input.threadId}/attachments/${encodeURIComponent(input.attachmentId)}`;
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, requestPath);
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "DELETE",
    requestUrl,
    signer,
  );

  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    ATTACHMENT_DELETE_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.orchestration.deleteAttachment({
        params: { threadId: input.threadId, attachmentId: input.attachmentId },
        headers,
      }),
    ),
  );
});
