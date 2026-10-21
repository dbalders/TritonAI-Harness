import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  deviceId,
  identityOf,
  recordId,
  teamA,
  teamProjectFixture as fixture,
} from "./testing/teamProjectFixture.ts";

const author = identityOf("alice");
const memoryPath = `Memory/${author}/${deviceId}/${recordId}.md`;

/** Alice, a member of team A, with Microsoft connected and tokens that refresh on every request. */
const connected = Effect.gen(function* () {
  const f = fixture();
  f.shortTokens();
  const services = yield* f.make;
  yield* services.connect(teamA);
  return { f, ...services };
});

const changes = [
  {
    name: "the member is removed from the team",
    change: (f: ReturnType<typeof fixture>) => void delete f.roles[teamA]!.alice,
  },
  {
    name: "the member becomes read-only",
    change: (f: ReturnType<typeof fixture>) => {
      f.roles[teamA]!.alice = "reader";
    },
  },
  {
    name: "the team folder changes",
    change: (f: ReturnType<typeof fixture>) => {
      f.storage[teamA] = { ...f.storage[teamA]!, folderId: "rootA2" };
    },
  },
  {
    name: "another campus account signs in",
    change: (f: ReturnType<typeof fixture>) => f.switchTo("mallory"),
  },
];

describe("Team file changes after a token refresh", () => {
  it.effect.each(
    changes.flatMap((scenario) =>
      (["publish", "update", "delete"] as const).map((command) => ({
        scenario,
        command,
        name: scenario.name,
      })),
    ),
  )("sends no $command when $name while the token refreshes", ({ scenario, command }) =>
    Effect.gen(function* () {
      const { f, storage } = yield* connected;
      // The refresh right before the change itself, after its folders were looked up.
      f.duringTokenRefresh(
        () =>
          f.graph.at(-1)?.startsWith("GET") === true &&
          (command === "publish"
            ? f.graph.at(-1)!.endsWith(`/${deviceId}`)
            : f.graph.at(-1)!.includes(`${recordId}.md`)),
        Effect.sync(() => scenario.change(f)),
      );
      const result = yield* storage
        .execute(
          "s",
          command === "publish"
            ? {
                action: "publish",
                teamId: teamA,
                recordId,
                deviceId,
                kind: "memory",
                title: "A note",
                project: "Grant reports",
                text: "Shared text",
              }
            : command === "update"
              ? {
                  action: "update-file",
                  teamId: teamA,
                  path: memoryPath,
                  etag: "v1",
                  text: "New",
                }
              : { action: "delete-file", teamId: teamA, path: memoryPath, etag: "v1" },
        )
        .pipe(Effect.flip);
      // Refused, or (for another account) the refreshed token itself is refused.
      expect(["forbidden", "conflict", "sign_in_required", "not_found", "unavailable"]).toContain(
        result.code,
      );
      expect(f.writes).toEqual([]);
    }),
  );

  it.effect("still sends a change when nothing changed during the refresh", () =>
    Effect.gen(function* () {
      const { f, storage } = yield* connected;
      yield* storage.execute("s", {
        action: "publish",
        teamId: teamA,
        recordId,
        deviceId,
        kind: "memory",
        title: "A note",
        project: "Grant reports",
        text: "Shared text",
      });
      expect(f.writes).toEqual([expect.objectContaining({ method: "PUT" })]);
    }),
  );
});
