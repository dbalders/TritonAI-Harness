import type { ReactElement } from "react";
import type { EnvironmentId, ServerSelfUpdateCapability } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ServerUpdateAction } from "./ServerUpdateAction";

function renderAction(selfUpdate: ServerSelfUpdateCapability | null) {
  return ServerUpdateAction({
    environmentId: "env-test" as EnvironmentId,
    serverLabel: "Test server",
    selfUpdate,
    targetVersion: "0.3.2",
  }) as ReactElement<{ readonly children: string }>;
}

describe("ServerUpdateAction", () => {
  it("keeps desktop-managed updates informational", () => {
    expect(renderAction("desktop-managed").props.children).toBe(
      "Update the TritonAI Harness desktop app on that machine to update this server.",
    );
  });

  it.each(["boot-service", "respawn", null] as const)(
    "never exposes public t3 update actions for %s",
    (capability) => {
      const action = renderAction(capability);
      expect(action.type).toBe("span");
      expect(action.props.children).toBe(
        "Automatic server updates are unavailable in TritonAI Harness.",
      );
    },
  );
});
