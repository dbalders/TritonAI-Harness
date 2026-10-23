import { describe, expect, it } from "vite-plus/test";
import { threadTeamSharingNotice } from "./useProjectTeamSharing";

const sharing = {
  teamId: "11111111-2222-4333-8444-555555555555",
  teamName: "Alpha",
  state: "sharing" as const,
  message: null,
  lastPublishedAt: null,
};

describe("threadTeamSharingNotice", () => {
  it("shows paused sharing while Teams is off and keeps the privacy opt-out available", () => {
    expect(threadTeamSharingNotice(sharing, true, false)).toMatchObject({
      variant: "info",
      title: "Sharing with Alpha is paused",
      action: "Don't share this thread",
    });
    expect(
      threadTeamSharingNotice({ ...sharing, state: "held" }, true, false).description,
    ).toContain("Previously shared summaries remain available");
  });

  it("does not offer to resume an opted-out thread until Teams is enabled again", () => {
    expect(threadTeamSharingNotice(sharing, false, false)).toMatchObject({
      title: "Not shared with Alpha",
      action: null,
    });
    expect(threadTeamSharingNotice(sharing, false, false).description).toContain(
      "Experimental settings",
    );
    expect(threadTeamSharingNotice(sharing, false, true).action).toBe("Share this thread");
  });

  it("says a thread in a team project is shared, and offers the way out", () => {
    expect(threadTeamSharingNotice(sharing, true)).toMatchObject({
      variant: "info",
      title: "Shared with Alpha",
      action: "Don't share this thread",
    });
  });

  it("says a thread chosen as Don't share stays out, and offers the way back", () => {
    expect(threadTeamSharingNotice(sharing, false)).toMatchObject({
      title: "Not shared with Alpha",
      action: "Share this thread",
    });
    // A held team doesn't change what an opted-out thread says.
    expect(threadTeamSharingNotice({ ...sharing, state: "held" }, false)).toMatchObject({
      title: "Not shared with Alpha",
    });
  });

  it("warns with the reason when sharing is waiting", () => {
    expect(
      threadTeamSharingNotice(
        { ...sharing, state: "held", message: "Memory is off, so your work isn't summarized." },
        true,
      ),
    ).toMatchObject({
      variant: "warning",
      description: "Memory is off, so your work isn't summarized.",
      action: "Don't share this thread",
    });
  });
});
