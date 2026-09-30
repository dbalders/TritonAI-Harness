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
  it.each(["desktop-managed", "boot-service", "respawn", null] as const)(
    "never exposes public t3 update actions for %s",
    (capability) => {
      const action = renderAction(capability);
      expect(action.type).toBe("span");
      expect(action.props.children.length).toBeGreaterThan(0);
      expect(renderToStaticMarkup(action)).not.toMatch(/<(?:button|a)\b/u);
    },
  );
});

describe("ServerUpdateProgress", () => {
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
