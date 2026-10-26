import { ServerUpdateAction } from "./ServerUpdateAction";
import { ServerUpdateProgress } from "./ServerUpdateAction";
import type { EnvironmentId, ServerSelfUpdateCapability } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { render } from "../../test/render";

describe("managed server updates", () => {
  it.each(["desktop-managed", "boot-service", "respawn", null] as const)(
    "keeps the approved host update path for %s",
    async (selfUpdate: ServerSelfUpdateCapability | null) => {
      await using screen = await render(
        <ServerUpdateAction
          environmentId={"env-test" as EnvironmentId}
          serverLabel="Test server"
          selfUpdate={selfUpdate}
          targetVersion="0.3.2"
        />,
      );
      expect(screen.container.textContent?.length).toBeGreaterThan(0);
      expect(screen.container.querySelector("button,a")).toBeNull();
    },
  );
  it("keeps a failed update visible", async () => {
    await using screen = await render(
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
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("The package could not be verified.");
  });
});
