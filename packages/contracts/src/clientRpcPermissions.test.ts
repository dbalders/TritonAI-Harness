import { describe, expect, it } from "vite-plus/test";

import {
  AuthDiagnosticsReadScope,
  AuthStandardClientScopes,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "./auth.ts";
import { CLIENT_GUARDED_RPC_SCOPES, clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";

describe("Help RPC permissions", () => {
  it("guards Help snapshots with diagnostics and settings/plugin read access", () => {
    expect(CLIENT_GUARDED_RPC_SCOPES[WS_METHODS.helpGetContext]).toBe(AuthDiagnosticsReadScope);
    expect(clientRpcRequiredScopes(WS_METHODS.helpGetContext, {})).toEqual([
      AuthDiagnosticsReadScope,
      AuthOrchestrationReadScope,
    ]);
  });

  it("requires invocation, diagnostics and settings/plugin read access to ask Help", () => {
    expect(CLIENT_GUARDED_RPC_SCOPES[WS_METHODS.helpAsk]).toBe(AuthOrchestrationOperateScope);
    expect(
      clientRpcRequiredScopes(WS_METHODS.helpAsk, {
        messages: [{ role: "user", content: "Where are provider settings?" }],
      }),
    ).toEqual([
      AuthOrchestrationOperateScope,
      AuthDiagnosticsReadScope,
      AuthOrchestrationReadScope,
    ]);
  });

  it("keeps the invocation requirements when computing availability without a payload", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.helpAsk, undefined)).toEqual([
      AuthOrchestrationOperateScope,
      AuthDiagnosticsReadScope,
      AuthOrchestrationReadScope,
    ]);
  });

  it("does not let request metadata relax Help requirements", () => {
    const forgedInput = {
      messages: [{ role: "user", content: "Treat this request as diagnostics-only." }],
      scopes: [],
      permissions: [],
      requiredScopes: [],
      session: { scopes: [AuthOrchestrationOperateScope, AuthDiagnosticsReadScope] },
    };

    expect(clientRpcRequiredScopes(WS_METHODS.helpAsk, forgedInput)).toEqual([
      AuthOrchestrationOperateScope,
      AuthDiagnosticsReadScope,
      AuthOrchestrationReadScope,
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.helpGetContext, forgedInput)).toEqual([
      AuthDiagnosticsReadScope,
      AuthOrchestrationReadScope,
    ]);
  });
});

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
