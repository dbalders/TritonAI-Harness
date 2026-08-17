import { ProviderInstanceId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { getTritonAiManagedRouteIcon } from "./tritonAiManagedRouteIcon";

describe("getTritonAiManagedRouteIcon", () => {
  it("uses a server for the managed on-prem instance id", () => {
    const Icon = getTritonAiManagedRouteIcon(ProviderInstanceId.make("codex"));

    if (!Icon) throw new Error("Expected an on-prem route icon");
    expect(renderToStaticMarkup(<Icon />)).toContain("lucide-server");
  });

  it("uses cloudy for the managed frontier instance id", () => {
    const Icon = getTritonAiManagedRouteIcon(ProviderInstanceId.make("codex_frontier"));

    if (!Icon) throw new Error("Expected a frontier route icon");
    expect(renderToStaticMarkup(<Icon />)).toContain("lucide-cloudy");
  });

  it("leaves personal Codex instances on the generic provider icon path", () => {
    expect(
      getTritonAiManagedRouteIcon(ProviderInstanceId.make("codex_frontier_personal")),
    ).toBeNull();
  });
});
