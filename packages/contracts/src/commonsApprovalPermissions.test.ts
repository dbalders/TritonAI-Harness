import { expect, it } from "vite-plus/test";
import { AuthProvidersManageScope } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";

it.each([
  WS_METHODS.serverSubmitProviderSkillToTritonAiCommons,
  WS_METHODS.serverRespondCommonsApproval,
])("requires provider management for public sharing mutation %s", (tag) => {
  expect(clientRpcRequiredScopes(tag, undefined)).toEqual([AuthProvidersManageScope]);
});
