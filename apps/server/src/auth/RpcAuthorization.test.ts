import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { RPC_REQUIRED_SCOPES, requiredScopeForRpcMethod } from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("preserves TritonAI management and integration scopes", () => {
    const readMethods = [
      WS_METHODS.serverGetTritonAiUsage,
      WS_METHODS.serverListProviderSkillCatalog,
      WS_METHODS.serverListPlugins,
      WS_METHODS.integrationsList,
    ];
    const operateMethods = [
      WS_METHODS.serverTranscribeVoice,
      WS_METHODS.serverInstallProviderSkill,
      WS_METHODS.serverRemoveProviderSkill,
      WS_METHODS.serverSetProviderSkillEnabled,
      WS_METHODS.serverInstallPlugin,
      WS_METHODS.serverUninstallPlugin,
      WS_METHODS.serverAddMarketplace,
      WS_METHODS.serverRemoveMarketplace,
      WS_METHODS.serverUpgradeMarketplace,
      WS_METHODS.integrationsInstall,
      WS_METHODS.integrationsSetEnabled,
      WS_METHODS.integrationsSetCapabilityEnabled,
      WS_METHODS.integrationsConnect,
      WS_METHODS.integrationsPoll,
      WS_METHODS.integrationsDisconnect,
    ];

    for (const method of readMethods) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
    for (const method of operateMethods) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toBe(
      AuthRelayReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toBe(AuthRelayWriteScope);
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});
