import { expect, it } from "vite-plus/test";
import { AuthStandardClientScopes } from "./auth.ts";
import { WS_METHODS } from "./rpc.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";

it.each([
  WS_METHODS.scheduledTasksUpsert,
  WS_METHODS.scheduledTasksRunNow,
  WS_METHODS.projectBriefExecute,
])("requires full device authority for %s regardless of request mode", (method) => {
  for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto", "full-access"]) {
    expect(new Set(clientRpcRequiredScopes(method, { runtimeMode }))).toEqual(
      new Set(AuthStandardClientScopes),
    );
  }
});
