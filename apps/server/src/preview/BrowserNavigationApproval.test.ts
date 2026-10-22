import { describe, expect, it } from "@effect/vitest";

import {
  dynamicToolApprovalRequired,
  planDynamicToolApproval,
} from "../provider/CodexDynamicTools.ts";
import {
  BROWSER_NAVIGATION_GRANT,
  BROWSER_SESSION_SCOPE,
  browserNavigationOutcome,
  browserNavigationRequest,
  browserNavigationTarget,
  describeBrowserNavigationForApproval,
} from "./BrowserNavigationApproval.ts";

describe("browser navigation approval", () => {
  it("names the exact external URL the browser will load", () => {
    expect(
      browserNavigationRequest("preview_navigate", { url: "mymap.example.test/ALZXFZ" }),
    ).toEqual({
      toolName: "preview_navigate",
      url: "https://mymap.example.test/ALZXFZ",
      unparsed: false,
    });
    expect(
      browserNavigationRequest("preview_navigate", {
        target: { kind: "url", url: "https://xn--pple-43d.example.test/login" },
      })?.url,
    ).toBe("https://xn--pple-43d.example.test/login");
    expect(
      browserNavigationRequest("preview_open", {
        url: "https://forms.example.test/x",
        profileId: "Work",
      }),
    ).toEqual({
      toolName: "preview_open",
      url: "https://forms.example.test/x",
      unparsed: false,
      profileId: "Work",
    });
  });

  it("does not treat blank tabs, dev-server ports, or loopback pages as external", () => {
    expect(browserNavigationRequest("preview_open", {})).toBeUndefined();
    expect(browserNavigationRequest("preview_open", { reuseExistingTab: false })).toBeUndefined();
    expect(
      browserNavigationRequest("preview_navigate", {
        target: { kind: "environment-port", port: 5173 },
      }),
    ).toBeUndefined();
    for (const url of [
      "localhost:5173",
      "http://127.0.0.1:3000/x",
      "http://127.8.9.10/",
      "http://[::1]:8080/",
      "http://app.localhost:4000/",
      "0.0.0.0:3000",
    ]) {
      expect(browserNavigationRequest("preview_navigate", { url })).toBeUndefined();
    }
    expect(
      browserNavigationRequest("preview_snapshot", { url: "https://a.example.test" }),
    ).toBeUndefined();
  });

  it("keeps a private-network or unparseable destination behind approval", () => {
    expect(
      browserNavigationRequest("preview_navigate", { url: "http://192.168.1.1/admin" })?.url,
    ).toBe("http://192.168.1.1/admin");
    expect(browserNavigationRequest("preview_navigate", { url: "javascript:alert(1)" })).toEqual({
      toolName: "preview_navigate",
      url: "javascript:alert(1)",
      unparsed: true,
    });
  });

  it("shows the complete destination without truncation", () => {
    const long = `https://ic6do.example.test/Ysh5Fd_urgent_update.cmd?${"a=1&".repeat(300)}z=1`;
    const request = browserNavigationRequest("preview_navigate", { url: long })!;
    expect(describeBrowserNavigationForApproval(request)).toBe(
      `Open a website in the browser (preview_navigate)\nSite: ic6do.example.test\nURL: ${long}\n${BROWSER_SESSION_SCOPE}`,
    );
    expect(
      describeBrowserNavigationForApproval(
        browserNavigationRequest("preview_open", {
          url: "https://a.example.test",
          profileId: "Work",
        })!,
      ),
    ).toContain("Browser profile: Work (its saved sign-ins)");
  });

  it("reports a redirect to a different site after navigation", () => {
    const request = browserNavigationRequest("preview_navigate", {
      url: "https://short.example.test/r",
    })!;
    expect(browserNavigationOutcome(request, "https://short.example.test/landing")).toBeUndefined();
    expect(browserNavigationOutcome(request, "https://www.short.example.test/")).toBeUndefined();
    expect(browserNavigationOutcome(request, "https://news.example.org/story")).toMatchObject({
      redirectedFrom: "https://short.example.test/r",
      redirectNotice: expect.stringContaining("news.example.org"),
    });
  });

  it("reports a local page forwarding to an external site without claiming approval", () => {
    const args = { url: "localhost:5173/login" };
    expect(browserNavigationRequest("preview_navigate", args)).toBeUndefined();
    const target = browserNavigationTarget("preview_navigate", args)!;
    expect(target).toMatchObject({ url: "http://localhost:5173/login", unparsed: false });
    expect(browserNavigationOutcome(target, "http://localhost:5173/home")).toBeUndefined();
    expect(browserNavigationOutcome(target, "http://127.0.0.1:5173/")).toBeUndefined();
    const outcome = browserNavigationOutcome(target, "https://tracker.example.org/p?id=1");
    expect(outcome).toMatchObject({
      redirectedFrom: "http://localhost:5173/login",
      redirectNotice: expect.stringContaining("different site, tracker.example.org"),
    });
    expect(outcome?.redirectNotice).not.toMatch(/approv(?:al|ed) covered/iu);
    expect(outcome?.redirectNotice).toContain("not approved");
  });

  it("finds no redirect for blank, environment-port, or unparsed targets", () => {
    expect(browserNavigationTarget("preview_open", {})).toBeUndefined();
    expect(
      browserNavigationTarget("preview_navigate", {
        target: { kind: "environment-port", port: 5173 },
      }),
    ).toBeUndefined();
    const unparsed = browserNavigationTarget("preview_navigate", { url: "javascript:alert(1)" })!;
    expect(browserNavigationOutcome(unparsed, "https://a.example.org/")).toBeUndefined();
  });
});

describe("dynamic tool approval plan", () => {
  type Arguments = Parameters<typeof planDynamicToolApproval>[0]["payload"]["arguments"];
  const plan = (tool: string, args: Arguments, requiresApproval?: boolean) =>
    planDynamicToolApproval({ requiresApproval, payload: { tool, arguments: args } });

  it("asks for external navigation in every mode except Full access", () => {
    const navigation = plan("preview_navigate", { url: "https://a.example.test" }, false);
    expect(navigation).toMatchObject({
      requiresApproval: true,
      grantKey: BROWSER_NAVIGATION_GRANT,
    });
    for (const mode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      expect(dynamicToolApprovalRequired(navigation.requiresApproval, false, mode)).toBe(true);
    }
    expect(dynamicToolApprovalRequired(navigation.requiresApproval, false, "full-access")).toBe(
      false,
    );
    expect(
      dynamicToolApprovalRequired(navigation.requiresApproval, true, "approval-required"),
    ).toBe(false);
  });

  it("shares one session grant between opening and navigating, and skips local pages", () => {
    expect(plan("preview_open", { url: "https://b.example.test" }, true).grantKey).toBe(
      plan("preview_navigate", { url: "https://c.example.test" }, false).grantKey,
    );
    expect(plan("preview_open", {}, true).requiresApproval).toBe(false);
    expect(plan("preview_open", { url: "localhost:5173" }, true).requiresApproval).toBe(false);
  });

  it("uses the one session browsing grant for named profiles and says so", () => {
    const work = plan("preview_open", { url: "https://d.example.test", profileId: "Work" }, true);
    expect(work).toMatchObject({ requiresApproval: true, grantKey: BROWSER_NAVIGATION_GRANT });
    expect(work.prompt).toContain("Browser profile: Work (its saved sign-ins)");
    expect(work.prompt).toContain(BROWSER_SESSION_SCOPE);
    const blank = plan("preview_open", { profileId: "Work" }, true);
    expect(blank).toMatchObject({ requiresApproval: true, grantKey: BROWSER_NAVIGATION_GRANT });
    expect(blank.prompt).toContain(BROWSER_SESSION_SCOPE);
    expect(
      plan("preview_open", { url: "localhost:5173", profileId: "Personal" }, true).grantKey,
    ).toBe(BROWSER_NAVIGATION_GRANT);
  });

  it("cannot see a reused tab's profile, so tab navigation shares the session grant", () => {
    const byTab = plan("preview_navigate", { tabId: "tab-work", url: "https://e.example.test" });
    expect(byTab).toMatchObject({ requiresApproval: true, grantKey: BROWSER_NAVIGATION_GRANT });
    expect(byTab.prompt).not.toContain("Browser profile:");
    expect(byTab.prompt).toContain(BROWSER_SESSION_SCOPE);
    const reuse = plan("preview_open", { tabId: "tab-work", url: "https://e.example.test" }, true);
    expect(reuse.grantKey).toBe(BROWSER_NAVIGATION_GRANT);
    expect(
      plan("preview_navigate", { url: "localhost:5173", profileId: "Work" }).requiresApproval,
    ).toBe(false);
  });

  it("leaves other tools on their declared approval", () => {
    expect(plan("preview_click", { ref: "e1" }, true)).toMatchObject({
      requiresApproval: true,
      grantKey: "preview_click",
    });
    expect(plan("fixture_records_write", { value: 1 }, true)).toMatchObject({
      requiresApproval: true,
      grantKey: "fixture_records_write",
    });
    expect(plan("fixture_records_read", {}, false).requiresApproval).toBe(false);
  });
});
