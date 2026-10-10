import { describe, expect, it } from "@effect/vitest";
import { TeamsError, type TeamStorageCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { executeDocument } from "./teamDocuments.ts";

const actor = "a".repeat(43);
const teamId = "11111111-1111-4111-a111-111111111111";
const device = "22222222-2222-4222-a222-222222222222";
const record = "33333333-3333-4333-a333-333333333333";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeFolder = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String })),
);
const publish = {
  action: "publish",
  teamId,
  recordId: record,
  deviceId: device,
  kind: "sop",
  title: "Onboarding",
  project: "Staff",
  text: "Check access first.",
} as const;
type Item = {
  id: string;
  parent: string;
  name: string;
  folder: boolean;
  text: string;
  version: number;
  remote?: boolean;
};
function fixture() {
  const items = new Map<string, Item>();
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const downloads: HttpClientRequest.HttpClientRequest[] = [];
  let allowed = true;
  let downloadHost = "example.sharepoint.com";
  let afterDownload = () => {};
  let beforeWrite = () => {};
  let beforeFolderCreate = (_name: string) => {};
  let hideSuccessfulWrite = false;
  const etag = (item: Item) => `"${item.id}-${item.version}"`;
  const metadata = (item: Item) => ({
    id: item.id,
    name: item.name,
    parentReference: { id: item.parent },
    eTag: etag(item),
    size: new TextEncoder().encode(item.text).byteLength,
    ...(item.folder
      ? { folder: {} }
      : {
          file: {},
          "@microsoft.graph.downloadUrl": `https://${downloadHost}/download/${item.id}`,
        }),
    ...(item.remote ? { remoteItem: {} } : {}),
  });
  const find = (parent: string, names: string[]) => {
    let item: Item | undefined;
    for (const name of names) {
      item = [...items.values()].find((entry) => entry.parent === parent && entry.name === name);
      if (!item) return;
      parent = item.id;
    }
    return item;
  };
  const send = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.sync(() => {
      requests.push(request);
      const url = new URL(request.url);
      const route = decodeURIComponent(url.pathname).replace("/v1.0/drives/drive/items/", "");
      const response = (status: number, value: unknown = {}) =>
        HttpClientResponse.fromWeb(
          request,
          new Response(status === 204 ? null : encodeJson(value), {
            status,
            headers: { "content-type": "application/json" },
          }),
        );
      if (request.method === "POST") {
        const body =
          request.body._tag === "Uint8Array"
            ? decodeFolder(new TextDecoder().decode(request.body.body))
            : { name: "invalid" };
        beforeFolderCreate(body.name);
        const [anchor, rawPath = ""] = route
          .replace(/\/?children$/u, "")
          .replace(/:$/u, "")
          .split(":/");
        const parentPath = rawPath.split("/").filter(Boolean);
        const resolved = parentPath.length ? find(anchor!, parentPath) : undefined;
        if (parentPath.length && !resolved?.folder) return response(404);
        const parent = resolved?.id ?? anchor!.replace(/\/$/u, "");
        if (find(parent, [body.name])) return response(409);
        const item: Item = {
          id: `item-${items.size}`,
          parent,
          name: body.name,
          folder: true,
          text: "",
          version: 1,
        };
        items.set(item.id, item);
        return response(201, metadata(item));
      }
      const [parent, raw = ""] = route.split(":/");
      const path = raw.split("/").filter(Boolean);
      if (request.method === "PUT") beforeWrite();
      const target = find(parent!, path);
      if (request.method === "GET") return target ? response(200, metadata(target)) : response(404);
      if (request.method === "DELETE") {
        if (!target) return response(404);
        if (request.headers["if-match"] !== etag(target)) return response(412);
        items.delete(target.id);
        return response(204);
      }
      if (request.method === "PUT") {
        const folder = path.length === 1 ? undefined : find(parent!, path.slice(0, -1));
        if (path.length > 1 && (!folder || !folder.folder)) return response(404);
        if (target && url.searchParams.get("@microsoft.graph.conflictBehavior") === "fail")
          return response(409);
        if (target && request.headers["if-match"] !== etag(target)) return response(412);
        const item = target ?? {
          id: `item-${items.size}`,
          parent: folder?.id ?? parent!,
          name: path.at(-1)!,
          folder: false,
          text: "",
          version: 0,
        };
        item.text =
          request.body._tag === "Uint8Array"
            ? new TextDecoder().decode(request.body.body)
            : "invalid";
        item.version++;
        items.set(item.id, item);
        return hideSuccessfulWrite ? response(503) : response(target ? 200 : 201, metadata(item));
      }
      return response(400);
    });
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      downloads.push(request);
      const item = items.get(new URL(request.url).pathname.split("/").at(-1)!);
      const text = item?.text ?? "";
      afterDownload();
      return HttpClientResponse.fromWeb(request, new Response(text, { status: item ? 200 : 404 }));
    }),
  );
  const execute = (
    command: Extract<
      TeamStorageCommand,
      { action: "publish" | "read-file" | "update-file" | "delete-file" }
    >,
    canWrite = true,
    actorId = actor,
  ) =>
    executeDocument({
      command,
      storage: {
        tenantId: "tenant",
        siteId: "example.sharepoint.com,site,web",
        driveId: "drive",
        folderId: "team-root",
      },
      actorId,
      canWrite,
      canManage: false,
      send,
      verifyCurrent: Effect.suspend(() =>
        allowed
          ? Effect.void
          : Effect.fail(new TeamsError({ code: "forbidden", message: "Membership revoked" })),
      ),
    }).pipe(
      Effect.map((result) => result.document),
      Effect.provideService(HttpClient.HttpClient, http),
    );
  return {
    execute,
    items,
    requests,
    downloads,
    setAllowed: (next: boolean) => {
      allowed = next;
    },
    setHost: (next: string) => {
      downloadHost = next;
    },
    afterDownload: (hook: () => void) => {
      afterDownload = hook;
    },
    beforeWrite: (hook: () => void) => {
      beforeWrite = hook;
    },
    beforeFolderCreate: (hook: (name: string) => void) => {
      beforeFolderCreate = hook;
    },
    hideWrite: (next: boolean) => {
      hideSuccessfulWrite = next;
    },
  };
}

describe("private team document transport", () => {
  it.effect("publishes separate actor/device records and retries without overwriting", () =>
    Effect.gen(function* () {
      const f = fixture();
      const first = yield* f.execute(publish);
      expect(first?.path).toBe(`SOPs/${actor}/${device}/${record}.md`);
      expect(yield* f.execute(publish)).toEqual(first);
      const other = yield* f.execute(publish, true, "b".repeat(43));
      expect(other?.path).not.toBe(first?.path);
      expect([...f.items.values()].filter((item) => !item.folder)).toHaveLength(2);
      expect((yield* Effect.flip(f.execute({ ...publish, text: "different" }))).code).toBe(
        "conflict",
      );
      expect(f.downloads.every((request) => !request.headers.authorization)).toBe(true);
    }),
  );
  it.effect("recovers an upload after the successful response was lost", () =>
    Effect.gen(function* () {
      const f = fixture();
      f.hideWrite(true);
      expect((yield* Effect.flip(f.execute(publish))).code).toBe("unavailable");
      f.hideWrite(false);
      const recovered = yield* f.execute(publish);
      expect(recovered?.text).toContain(publish.text);
      expect([...f.items.values()].filter((item) => !item.folder)).toHaveLength(1);
    }),
  );
  it.effect("rejects stale updates and deletion while preserving the newer content", () =>
    Effect.gen(function* () {
      const f = fixture();
      const first = (yield* f.execute(publish))!;
      const next = (yield* f.execute({
        action: "update-file",
        teamId,
        path: first.path,
        etag: first.etag,
        text: "New SOP",
      }))!;
      expect(
        (yield* Effect.flip(
          f.execute({
            action: "update-file",
            teamId,
            path: first.path,
            etag: first.etag,
            text: "Stale SOP",
          }),
        )).code,
      ).toBe("conflict");
      expect(
        (yield* Effect.flip(
          f.execute({ action: "delete-file", teamId, path: first.path, etag: first.etag }),
        )).code,
      ).toBe("conflict");
      expect(yield* f.execute({ action: "read-file", teamId, path: first.path })).toEqual(next);
      expect(
        yield* f.execute({ action: "delete-file", teamId, path: next.path, etag: next.etag }),
      ).toBeNull();
    }),
  );
  it.effect("blocks reader writes, traversal, and another author's deletion", () =>
    Effect.gen(function* () {
      const f = fixture();
      expect((yield* Effect.flip(f.execute(publish, false))).code).toBe("forbidden");
      expect(
        (yield* Effect.flip(
          f.execute({ action: "read-file", teamId, path: "../other-team/secret.md" }),
        )).code,
      ).toBe("invalid_request");
      expect(f.requests).toHaveLength(0);
      const note = (yield* f.execute({ ...publish, kind: "memory" }))!;
      const edited = yield* f.execute({
        action: "update-file",
        teamId,
        path: note.path,
        etag: note.etag,
        text: "Corrected work summary",
      });
      expect(edited?.text).toBe("Corrected work summary");
      expect(
        (yield* Effect.flip(
          f.execute(
            { action: "delete-file", teamId, path: note.path, etag: note.etag },
            true,
            "b".repeat(43),
          ),
        )).code,
      ).toBe("forbidden");
    }),
  );
  it.effect("discards a download after membership revocation or folder movement", () =>
    Effect.gen(function* () {
      for (const change of ["revoked", "moved"] as const) {
        const f = fixture();
        const note = (yield* f.execute(publish))!;
        f.afterDownload(() => {
          if (change === "revoked") f.setAllowed(false);
          else [...f.items.values()].find((item) => item.name === device)!.parent = "other-team";
        });
        const failure = yield* Effect.flip(
          f.execute({ action: "read-file", teamId, path: note.path }),
        );
        expect(["forbidden", "not_found"]).toContain(failure.code);
      }
    }),
  );
  it.effect("anchors writes at the team root if the parent moves just before upload", () =>
    Effect.gen(function* () {
      const f = fixture();
      const note = (yield* f.execute(publish))!;
      f.beforeWrite(() => {
        [...f.items.values()].find((item) => item.name === device)!.parent = "other-team";
      });
      expect(
        (yield* Effect.flip(
          f.execute({
            action: "update-file",
            teamId,
            path: note.path,
            etag: note.etag,
            text: "leaked",
          }),
        )).code,
      ).toBe("unavailable");
      expect([...f.items.values()].find((item) => !item.folder)?.text).toBe(note.text);
    }),
  );
  it.effect("cannot create a device folder when its actor folder moves outside the team", () =>
    Effect.gen(function* () {
      const f = fixture();
      f.beforeFolderCreate((name) => {
        if (name === device)
          [...f.items.values()].find((item) => item.name === actor)!.parent = "other-team";
      });
      expect((yield* Effect.flip(f.execute(publish))).code).toBe("not_found");
      expect([...f.items.values()].some((item) => item.name === device)).toBe(false);
      expect([...f.items.values()].some((item) => !item.folder)).toBe(false);
    }),
  );
  it.effect("rejects shortcuts and untrusted download hosts without requesting them", () =>
    Effect.gen(function* () {
      const f = fixture();
      const note = (yield* f.execute(publish))!;
      f.setHost("attacker.example");
      expect(
        (yield* Effect.flip(f.execute({ action: "read-file", teamId, path: note.path }))).code,
      ).toBe("unavailable");
      expect(f.downloads).toHaveLength(0);
      [...f.items.values()].find((item) => item.name === "SOPs")!.remote = true;
      expect(
        (yield* Effect.flip(f.execute({ action: "read-file", teamId, path: note.path }))).code,
      ).toBe("unavailable");
      expect(f.downloads).toHaveLength(0);
    }),
  );
});
