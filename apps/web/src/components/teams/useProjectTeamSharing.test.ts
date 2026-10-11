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
