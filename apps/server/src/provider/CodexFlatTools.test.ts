import { assert, describe, it } from "@effect/vitest";
import { deferredPluginTool } from "./CodexFlatTools.ts";

describe("deferredPluginTool", () => {
  it("groups a plugin tool under its plugin so Codex tool search can defer it", () => {
    assert.deepEqual(deferredPluginTool("microsoft365.mail.search", true), {
      namespace: "microsoft365",
      deferLoading: true,
    });
    assert.deepEqual(deferredPluginTool("kuali-build.forms.list", true), {
      namespace: "kuali-build",
      deferLoading: true,
    });
  });

  it("keeps tools direct when deferral is off or the namespace is unusable", () => {
    assert.deepEqual(deferredPluginTool("microsoft365.mail.search", false), {});
    for (const name of ["functions.run", "tool_search.x", "web.fetch", "mcp__x.y", ".bare"])
      assert.deepEqual(deferredPluginTool(name, true), {}, name);
    assert.deepEqual(deferredPluginTool(`${"a".repeat(65)}.tool`, true), {});
  });
});
