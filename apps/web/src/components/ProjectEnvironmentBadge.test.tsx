import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectGroupMember } from "~/sidebarProjectGrouping";
import { ProjectEnvironmentBadge } from "./ProjectEnvironmentBadge";

const LOCAL = "env-local" as EnvironmentId;
const LAPTOP = "env-laptop" as EnvironmentId;

function member(environmentId: EnvironmentId, environmentLabel: string | null) {
  return { environmentId, environmentLabel } as SidebarProjectGroupMember;
}

const machines = new Map<EnvironmentId, EnvironmentMachineKind>([[LAPTOP, "laptop"]]);

describe("ProjectEnvironmentBadge", () => {
  it("renders nothing for a folder that only lives on this device", () => {
    const markup = renderToStaticMarkup(
      <ProjectEnvironmentBadge
        group={{ memberProjects: [member(LOCAL, "This Mac")] }}
        primaryEnvironmentId={LOCAL}
        machineByEnvironmentId={machines}
      />,
    );
    expect(markup).toBe("");
  });

  it("names the other machine for a folder that lives there", () => {
    const markup = renderToStaticMarkup(
      <ProjectEnvironmentBadge
        group={{ memberProjects: [member(LAPTOP, "laptop")] }}
        primaryEnvironmentId={LOCAL}
        machineByEnvironmentId={machines}
        className="ml-0 text-sidebar-muted-foreground"
      />,
    );
    expect(markup).toContain('aria-label="On laptop"');
    // The folder header sits the icon right after the name, not at the row end.
    expect(markup).toContain("ml-0");
    expect(markup).not.toContain("ml-auto");
    expect(markup).toContain("text-sidebar-muted-foreground");
  });
});
