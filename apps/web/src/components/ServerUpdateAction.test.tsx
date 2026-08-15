import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EnvironmentId, ServerSelfUpdateCapability } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ServerUpdateAction, ServerUpdateProgress } from "./ServerUpdateAction";

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

describe("ServerUpdateProgress", () => {
  it("shows one calm status row for the restart wait", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateProgress
        state={{
          status: "running",
          stage: "resuming",
          fromVersion: "0.3.2",
          targetVersion: "0.3.3",
        }}
      />,
    );

    expect(markup).toContain("Restarting…");
    expect(markup).not.toContain("0.3.2");
    expect(markup).toContain("animate-status-pulse");
  });

  it("keeps update failures visible", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateProgress
        state={{
          status: "failed",
          stage: "installing",
          fromVersion: "0.3.2",
          targetVersion: "0.3.3",
          message: "The package could not be verified.",
        }}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The package could not be verified.");
  });
});
