import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  formatTeamNote,
  MAX_TEAM_DOCUMENT_BYTES,
  TeamProjectCommand,
  TeamStorageCommand,
} from "./teams.ts";

const teamId = "11111111-1111-4111-8111-111111111111";
const recordId = "22222222-2222-4222-8222-222222222222";
const deviceId = "33333333-3333-4333-8333-333333333333";
const projectId = "test-project";
const channels = ["storage", "project-memory", "project-skill"] as const;
type Channel = (typeof channels)[number];
const decodeStorage = Schema.decodeUnknownSync(TeamStorageCommand);
const decodeProject = Schema.decodeUnknownSync(TeamProjectCommand);
const update = (channel: Channel, text: string) => {
  const kind = channel === "project-skill" ? "Skills" : "Memory";
  const common = { path: `${kind}/${"a".repeat(43)}/${deviceId}/${recordId}.md`, etag: "v1", text };
  return channel === "storage"
    ? decodeStorage({ action: "update-file", teamId, ...common })
    : decodeProject({
        action: channel === "project-skill" ? "skill-update" : "memory-update",
        projectId,
        ...common,
      });
};

describe("team document publish/update compatibility", () => {
  it.each(channels)("can edit a maximum published document through %s", (channel) => {
    const fields = {
      recordId,
      deviceId,
      title: "t".repeat(80),
      text: "a".repeat(60_000),
    };
    const description = "d".repeat(200);
    if (channel === "storage")
      decodeStorage({
        action: "publish",
        teamId,
        kind: "memory",
        project: "p".repeat(80),
        ...fields,
      });
    else
      decodeProject({
        action: channel === "project-skill" ? "skill-publish" : "memory-publish",
        projectId,
        ...(channel === "project-skill" ? { description } : {}),
        ...fields,
      });
    const stored = formatTeamNote({
      ...fields,
      ...(channel === "project-skill" ? { description } : {}),
      project: "p".repeat(80),
    });
    expect(stored.length).toBeGreaterThan(60_000);
    expect(new TextEncoder().encode(stored).byteLength).toBeLessThanOrEqual(
      MAX_TEAM_DOCUMENT_BYTES,
    );
    expect(() => update(channel, stored.replace("a", "b"))).not.toThrow();
  });

  it.each(channels)("keeps %s updates bounded by the full-document size", (channel) => {
    expect(() => update(channel, "a".repeat(MAX_TEAM_DOCUMENT_BYTES))).not.toThrow();
    expect(() => update(channel, "a".repeat(MAX_TEAM_DOCUMENT_BYTES + 1))).toThrow();
  });
});
