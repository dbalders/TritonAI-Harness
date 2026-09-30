// @effect-diagnostics nodeBuiltinImport:off - A fake download edits a note synchronously mid-request.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { DailyMemory } from "../DailyMemory.ts";
import * as MemorySync from "./MemorySync.ts";
import * as MicrosoftSignIn from "./microsoftSignIn.ts";

const OAUTH = {
  clientId: "fcfe0e23-a675-4851-99a7-704dfd153b9c",
  tenantId: "8a198873-4fec-4e76-8182-ca479edbbd60",
};
const ACCOUNT = "account-1";
// Fixtures are plain JSON files written the way Memory writes them.
const toJson = (value: unknown) => JSON.stringify(value);
const fromJson = (text: string) => JSON.parse(text) as unknown;

interface FakeItem {
  readonly id: string;
  name: string;
  parentId: string | null;
  readonly folder: boolean;
  content: Uint8Array;
  eTag: string;
}

/**
 * An in-memory OneDrive with the behavior the Graph spike measured: create
 * with `conflictBehavior=fail` returns 409, a stale `If-Match` returns 412,
 * and folder delta lists a subtree then only changes, with deletions by id.
 */
class FakeOneDrive {
  readonly items = new Map<string, FakeItem>([
    [
      "root",
      {
        id: "root",
        name: "root",
        parentId: null,
        folder: true,
        content: new Uint8Array(),
        eTag: "r",
      },
    ],
  ]);
  readonly changes: Array<{
    readonly seq: number;
    readonly id: string;
    readonly deleted: boolean;
    readonly parentId: string | null;
  }> = [];
  readonly refreshTokens = new Set<string>(["plugin-rt"]);
  /** Runs while a file is being downloaded, to simulate an edit made mid-pass. */
  onDownload: (() => void) | null = null;
  devicePolls = 0;
  private next = 1;

  private record(item: FakeItem, deleted = false) {
    this.changes.push({ seq: this.next++, id: item.id, deleted, parentId: item.parentId });
  }

  private child(parentId: string, name: string) {
    return [...this.items.values()].find(
      (item) => item.parentId === parentId && item.name.toLowerCase() === name.toLowerCase(),
    );
  }

  private isBelow(id: string | null, ancestorId: string): boolean {
    for (let current = id, depth = 0; current !== null && depth < 64; depth++) {
      if (current === ancestorId) return true;
      current = this.items.get(current)?.parentId ?? null;
    }
    return false;
  }

  private json(item: FakeItem) {
    return {
      id: item.id,
      name: item.name,
      eTag: item.eTag,
      parentReference: { id: item.parentId },
      ...(item.folder ? { folder: {} } : { file: {} }),
    };
  }

  /** The file at `a/b/c` below the drive root, for assertions. */
  file(path: string): string | null {
    let current = "root";
    for (const name of path.split("/")) {
      const found = this.child(current, name);
      if (!found) return null;
      current = found.id;
    }
    return new TextDecoder().decode(this.items.get(current)!.content);
  }

  private create(parentId: string, name: string, folder: boolean, content = new Uint8Array()) {
    const item: FakeItem = {
      id: `item-${this.next}`,
      name,
      parentId,
      folder,
      content,
      eTag: `e-${this.next}`,
    };
    this.items.set(item.id, item);
    this.record(item);
    return item;
  }

  handle(method: string, url: URL, headers: Record<string, string>, body: Uint8Array) {
    const reply = (status: number, value?: unknown) => ({
      status,
      body: value === undefined ? "" : toJson(value),
    });
    if (url.host === "login.microsoftonline.com") {
      const params = new URLSearchParams(new TextDecoder().decode(body));
      if (url.pathname.endsWith("/devicecode")) {
        return reply(200, {
          device_code: "device-code",
          user_code: "ABCD1234",
          verification_uri: "https://microsoft.com/devicelogin",
          expires_in: 900,
          interval: 5,
        });
      }
      if (params.get("grant_type") === "refresh_token") {
        const token = params.get("refresh_token") ?? "";
        return this.refreshTokens.has(token)
          ? reply(200, { access_token: "access", expires_in: 3600, refresh_token: token })
          : reply(400, {
              error: "invalid_grant",
              error_description: "AADSTS70000: expired\r\nTrace ID: x",
            });
      }
      if (this.devicePolls++ === 0) return reply(400, { error: "authorization_pending" });
      this.refreshTokens.add("device-rt");
      return reply(200, { access_token: "access", expires_in: 3600, refresh_token: "device-rt" });
    }
    if (headers.authorization !== "Bearer access")
      return reply(401, { error: { code: "InvalidAuthenticationToken" } });
    const route = decodeURIComponent(url.pathname.replace(/^\/v1\.0/u, ""));
    if (route === "/me") return reply(200, { id: ACCOUNT, userPrincipalName: "person@ucsd.edu" });
    if (route === "/me/drive") return reply(200, { id: "drive-1" });

    const childPath = /^\/me\/drive\/(?:root|items\/([^/:]+)):\/(.+?)(?::\/content)?$/u.exec(route);
    if (childPath) {
      const parentId = childPath[1] ?? "root";
      const name = childPath[2]!;
      const existing = this.child(parentId, name);
      if (method === "GET")
        return existing
          ? reply(200, this.json(existing))
          : reply(404, { error: { code: "itemNotFound" } });
      // PUT content
      const ifMatch = headers["if-match"];
      if (url.searchParams.get("@microsoft.graph.conflictBehavior") === "fail" && existing) {
        return reply(409, { error: { code: "nameAlreadyExists" } });
      }
      if (ifMatch !== undefined && (!existing || existing.eTag !== ifMatch)) {
        return reply(412, { error: { code: "resourceModified" } });
      }
      if (existing) {
        existing.content = body;
        existing.eTag = `e-${this.next}`;
        this.record(existing);
        return reply(200, this.json(existing));
      }
      return reply(201, this.json(this.create(parentId, name, false, new Uint8Array(body))));
    }
    const children = /^\/me\/drive\/(?:root|items\/([^/]+))\/children$/u.exec(route);
    if (children && method === "POST") {
      const parentId = children[1] ?? "root";
      const request = fromJson(new TextDecoder().decode(body)) as { name: string };
      if (this.child(parentId, request.name))
        return reply(409, { error: { code: "nameAlreadyExists" } });
      return reply(201, this.json(this.create(parentId, request.name, true)));
    }
    const delta = /^\/me\/drive\/items\/([^/]+)\/delta$/u.exec(route);
    if (delta) {
      const folderId = delta[1]!;
      if (!this.items.has(folderId)) return reply(404, { error: { code: "itemNotFound" } });
      const since = Number(url.searchParams.get("token") ?? "-1");
      const value =
        since < 0
          ? [...this.items.values()]
              .filter((item) => this.isBelow(item.id, folderId))
              .map((item) => this.json(item))
          : [
              ...new Map(
                this.changes
                  .filter((change) => change.seq > since && this.isBelow(change.parentId, folderId))
                  .map((change) => [change.id, change] as const),
              ).values(),
            ].map((change) => {
              const item = this.items.get(change.id);
              return change.deleted || !item
                ? { id: change.id, deleted: {}, parentReference: { id: change.parentId } }
                : this.json(item);
            });
      return reply(200, {
        value,
        "@odata.deltaLink": `https://graph.microsoft.com/v1.0/me/drive/items/${folderId}/delta?token=${this.next - 1}`,
      });
    }
    const content = /^\/me\/drive\/items\/([^/]+)\/content$/u.exec(route);
    if (content) {
      const item = this.items.get(content[1]!);
      this.onDownload?.();
      return item
        ? { status: 200, body: item.content }
        : reply(404, { error: { code: "itemNotFound" } });
    }
    const item = /^\/me\/drive\/items\/([^/]+)$/u.exec(route);
    if (item && method === "DELETE") {
      const existing = this.items.get(item[1]!);
      if (!existing) return reply(404, { error: { code: "itemNotFound" } });
      if (headers["if-match"] !== undefined && headers["if-match"] !== existing.eTag) {
        return reply(412, { error: { code: "resourceModified" } });
      }
      this.items.delete(existing.id);
      this.record(existing, true);
      return reply(204);
    }
    return reply(400, { error: { code: `unhandled ${method} ${route}` } });
  }

  layer() {
    return Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          const body = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
          const headers = Object.fromEntries(
            Object.entries(request.headers).map(([key, value]) => [
              key.toLowerCase(),
              String(value),
            ]),
          );
          const url = new URL(request.url);
          for (const [key, value] of request.urlParams) url.searchParams.append(key, value);
          const reply = this.handle(request.method, url, headers, body);
          return HttpClientResponse.fromWeb(
            request,
            new Response(reply.status === 204 ? null : reply.body, { status: reply.status }),
          );
        }),
      ),
    );
  }
}

interface Computer {
  readonly environmentId: string;
  readonly shortId: string;
  readonly name: string;
}
const MAC: Computer = {
  environmentId: "aaaa1111-0000-4000-8000-000000000001",
  shortId: "aaaa",
  name: "Mac",
};
const IMAC: Computer = {
  environmentId: "bbbb2222-0000-4000-8000-000000000002",
  shortId: "bbbb",
  name: "iMac",
};

const setup = (drive: FakeOneDrive, computer: Computer) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-sync-test-" });
    const baseDir = path.join(temporary, ".tritonai-harness");
    const vault = path.join(baseDir, "memory", "general");
    const label = `${computer.name} (${computer.shortId})`;
    const write = (relativePath: string, contents: string) =>
      fs
        .makeDirectory(path.dirname(path.join(vault, relativePath)), { recursive: true })
        .pipe(Effect.andThen(fs.writeFileString(path.join(vault, relativePath), contents)));
    const read = (relativePath: string) =>
      fs.readFileString(path.join(vault, relativePath)).pipe(Effect.orElseSucceed(() => null));
    // What Memory would have written on this computer.
    const registerDevice = write(
      `.devices/${computer.environmentId}/device.json`,
      `${toJson({ version: 1, id: computer.environmentId, shortId: computer.shortId, name: computer.name, platform: "darwin", lastSeen: "2026-09-29T20:00:00.000Z" })}\n`,
    );
    const writeDay = (day: string, text: string) =>
      Effect.gen(function* () {
        const relativePath = `Daily/2026/${day} ${label}.md`;
        yield* write(relativePath, text);
        const writtenPath = `.devices/${computer.environmentId}/written.json`;
        const current = fromJson((yield* read(writtenPath)) ?? '{"version":1,"files":{}}') as {
          files: Record<string, string>;
        };
        current.files[relativePath] = "hash";
        yield* write(writtenPath, toJson({ version: 1, ...current }));
      });

    const lock = yield* Semaphore.make(1);
    // The service without its schedule, so each test decides when a pass runs.
    const layer = Layer.effect(MemorySync.MemorySync, MemorySync.make).pipe(
      Layer.provide(
        Layer.effect(MicrosoftSignIn.MicrosoftSignIn, MicrosoftSignIn.make(OAUTH)).pipe(
          Layer.provide(drive.layer()),
        ),
      ),
      Layer.provideMerge(drive.layer()),
      Layer.provideMerge(
        Layer.mergeAll(
          ServerSettings.layerTest({ memoryEnabled: true }),
          Layer.mock(ServerEnvironment)({
            getDescriptor: Effect.succeed({
              environmentId: computer.environmentId,
              label: computer.name,
            } as unknown as ExecutionEnvironmentDescriptor),
          }),
          Layer.mock(DailyMemory)({
            exclusive: (effect) => lock.withPermits(1)(effect),
            getStatus: Effect.succeed({
              enabled: true,
              directoryPath: path.join(baseDir, "memory"),
              generalDirectoryPath: vault,
              state: "idle",
              lastSummarizedDay: null,
              message: null,
            }),
          }),
        ),
      ),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
    );
    // One set of services per computer for the whole test, like a running app.
    const context = yield* Layer.build(layer);
    return { vault, label, write, read, registerDevice, writeDay, layer: context, fs, path };
  });

it.layer(NodeServices.layer)("MemorySync", (it) => {
  it.effect("syncs two computers through OneDrive without either overwriting the other", () =>
    Effect.gen(function* () {
      const drive = new FakeOneDrive();
      const mac = yield* setup(drive, MAC);
      const imac = yield* setup(drive, IMAC);
      const cloud = (relativePath: string) =>
        drive.file(`TritonAI Harness/memory/general/${relativePath}`);

      // The Mac already has the Microsoft 365 plugin connected: no second sign-in.
      yield* Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        yield* secrets.set(
          "integration-microsoft-365--oauth",
          new TextEncoder().encode(
            toJson({
              version: 2,
              refreshToken: "plugin-rt",
              grantedScopes: [],
              grantedCapabilities: [],
              updatedAt: "x",
            }),
          ),
        );
        yield* mac.registerDevice;
        yield* mac.writeDay("2026-09-28", "Mac worked on login.\n");
        yield* mac.write(`Inbox/${MAC.shortId}/2026-09-29-0900-idea.md`, "Pending idea.\n");
        yield* mac.write("Notes/plans.md", "Plan v1\n");
        yield* mac.write("AGENTS.md", "local guide\n");
        const sync = yield* MemorySync.MemorySync;
        assert.deepStrictEqual(yield* sync.start, { kind: "connected" });
        yield* sync.syncNow;
        const status = yield* sync.getStatus;
        assert.strictEqual(status.sync.state, "idle");
        assert.strictEqual(status.sync.account, "person@ucsd.edu");
        assert.isNotNull(status.sync.lastSyncedAt);
      }).pipe(Effect.provide(mac.layer));

      assert.strictEqual(cloud("Daily/2026/2026-09-28 Mac (aaaa).md"), "Mac worked on login.\n");
      assert.strictEqual(cloud("Notes/plans.md"), "Plan v1\n");
      assert.isNull(cloud("AGENTS.md"));

      // The iMac signs in with a device code, then pulls the Mac's notes.
      yield* Effect.gen(function* () {
        yield* imac.registerDevice;
        yield* imac.writeDay("2026-09-29", "iMac reviewed PRs.\n");
        const sync = yield* MemorySync.MemorySync;
        assert.strictEqual((yield* sync.getStatus).sync.state, "off");
        const started = yield* sync.start;
        assert.strictEqual(started.kind, "device_code");
        if (started.kind !== "device_code") return;
        assert.strictEqual(started.userCode, "ABCD1234");
        assert.strictEqual((yield* sync.poll(started.flowId)).state, "pending");
        assert.strictEqual((yield* sync.poll(started.flowId)).state, "connected");
        yield* sync.syncNow;
      }).pipe(Effect.provide(imac.layer));

      assert.strictEqual(
        yield* imac.read("Daily/2026/2026-09-28 Mac (aaaa).md"),
        "Mac worked on login.\n",
      );
      assert.strictEqual(
        yield* imac.read(`Inbox/${MAC.shortId}/2026-09-29-0900-idea.md`),
        "Pending idea.\n",
      );
      assert.strictEqual(yield* imac.read("Notes/plans.md"), "Plan v1\n");
      assert.strictEqual(cloud("Daily/2026/2026-09-29 iMac (bbbb).md"), "iMac reviewed PRs.\n");

      // Both computers edit the same note; the Mac processes its inbox note.
      yield* mac.write("Notes/plans.md", "Plan v2 from Mac\n");
      yield* imac.write("Notes/plans.md", "Plan v2 from iMac\n");
      yield* mac.fs.remove(
        mac.path.join(mac.vault, `Inbox/${MAC.shortId}/2026-09-29-0900-idea.md`),
      );
      yield* mac.write(
        `Inbox/${MAC.shortId}/processed/2026-09-29/2026-09-29-0900-idea.md`,
        "Pending idea.\n",
      );
      yield* Effect.gen(function* () {
        yield* (yield* MemorySync.MemorySync).syncNow;
      }).pipe(Effect.provide(mac.layer));
      assert.strictEqual(cloud("Notes/plans.md"), "Plan v2 from Mac\n");
      assert.isNull(cloud(`Inbox/${MAC.shortId}/2026-09-29-0900-idea.md`));
      assert.strictEqual(
        cloud(`Inbox/${MAC.shortId}/processed/2026-09-29/2026-09-29-0900-idea.md`),
        "Pending idea.\n",
      );

      yield* Effect.gen(function* () {
        const sync = yield* MemorySync.MemorySync;
        yield* sync.syncNow;
        // The conflict copy made locally uploads on the next pass.
        yield* sync.syncNow;
      }).pipe(Effect.provide(imac.layer));
      // The iMac keeps its edit under a conflict name and takes the Mac's version.
      assert.strictEqual(yield* imac.read("Notes/plans.md"), "Plan v2 from Mac\n");
      const notes = yield* imac.fs.readDirectory(imac.path.join(imac.vault, "Notes"));
      const conflict = notes.find((name) => name.startsWith("plans (conflict iMac (bbbb) "));
      assert.isDefined(conflict);
      assert.strictEqual(yield* imac.read(`Notes/${conflict}`), "Plan v2 from iMac\n");
      assert.strictEqual(cloud(`Notes/${conflict}`), "Plan v2 from iMac\n");
      // The Mac's processed inbox note moved on the iMac too.
      assert.isNull(yield* imac.read(`Inbox/${MAC.shortId}/2026-09-29-0900-idea.md`));
      assert.strictEqual(
        yield* imac.read(`Inbox/${MAC.shortId}/processed/2026-09-29/2026-09-29-0900-idea.md`),
        "Pending idea.\n",
      );
    }),
  );

  it.effect("restores a lost vault from OneDrive instead of deleting the cloud copy", () =>
    Effect.gen(function* () {
      const drive = new FakeOneDrive();
      const mac = yield* setup(drive, MAC);
      const cloud = (relativePath: string) =>
        drive.file(`TritonAI Harness/memory/general/${relativePath}`);
      const day = "Daily/2026/2026-09-28 Mac (aaaa).md";

      yield* Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        yield* secrets.set(
          "integration-microsoft-365--oauth",
          new TextEncoder().encode(toJson({ refreshToken: "plugin-rt" })),
        );
        yield* mac.registerDevice;
        yield* mac.writeDay("2026-09-28", "Mac worked on login.\n");
        const sync = yield* MemorySync.MemorySync;
        yield* sync.start;
        yield* sync.syncNow;
      }).pipe(Effect.provide(mac.layer));
      assert.strictEqual(cloud(day), "Mac worked on login.\n");

      // The whole vault, sync state included, is gone. Memory registers the
      // computer again before sync runs.
      yield* mac.fs.remove(mac.vault, { recursive: true });
      yield* mac.registerDevice;
      yield* Effect.gen(function* () {
        yield* (yield* MemorySync.MemorySync).syncNow;
      }).pipe(Effect.provide(mac.layer));

      assert.strictEqual(yield* mac.read(day), "Mac worked on login.\n");
      assert.strictEqual(cloud(day), "Mac worked on login.\n");
    }),
  );

  it.effect("stops without deleting cloud notes when part of the vault cannot be read", () =>
    Effect.gen(function* () {
      const drive = new FakeOneDrive();
      const mac = yield* setup(drive, MAC);
      const cloud = (relativePath: string) =>
        drive.file(`TritonAI Harness/memory/general/${relativePath}`);
      const notes = mac.path.join(mac.vault, "Notes");
      yield* Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        yield* secrets.set(
          "integration-microsoft-365--oauth",
          new TextEncoder().encode(toJson({ refreshToken: "plugin-rt" })),
        );
        yield* mac.registerDevice;
        yield* mac.write("Notes/plans.md", "Plan v1\n");
        const sync = yield* MemorySync.MemorySync;
        yield* sync.start;
        yield* sync.syncNow;
        assert.strictEqual(cloud("Notes/plans.md"), "Plan v1\n");

        yield* mac.fs.chmod(notes, 0o000);
        yield* sync.syncNow.pipe(Effect.ensuring(mac.fs.chmod(notes, 0o755).pipe(Effect.ignore)));
        const status = yield* sync.getStatus;
        assert.strictEqual(status.sync.state, "error");
        assert.strictEqual(cloud("Notes/plans.md"), "Plan v1\n");
      }).pipe(Effect.provide(mac.layer));
    }),
  );

  it.effect("keeps a note edited while its cloud version downloads", () =>
    Effect.gen(function* () {
      const drive = new FakeOneDrive();
      const mac = yield* setup(drive, MAC);
      const imac = yield* setup(drive, IMAC);
      const signInWithPlugin = Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        yield* secrets.set(
          "integration-microsoft-365--oauth",
          new TextEncoder().encode(toJson({ refreshToken: "plugin-rt" })),
        );
        const sync = yield* MemorySync.MemorySync;
        yield* sync.start;
        return sync;
      });
      yield* Effect.gen(function* () {
        yield* mac.registerDevice;
        yield* mac.write("Notes/plans.md", "Plan v1\n");
        yield* (yield* signInWithPlugin).syncNow;
      }).pipe(Effect.provide(mac.layer));
      yield* Effect.gen(function* () {
        yield* imac.registerDevice;
        yield* (yield* signInWithPlugin).syncNow;
      }).pipe(Effect.provide(imac.layer));

      // The Mac changes the note; the iMac's user edits it while it downloads.
      yield* mac.write("Notes/plans.md", "Plan v2 from Mac\n");
      yield* Effect.gen(function* () {
        yield* (yield* MemorySync.MemorySync).syncNow;
      }).pipe(Effect.provide(mac.layer));
      const localPlans = imac.path.join(imac.vault, "Notes", "plans.md");
      drive.onDownload = () => NodeFS.writeFileSync(localPlans, "Typed on the iMac mid-sync\n");
      yield* Effect.gen(function* () {
        const sync = yield* MemorySync.MemorySync;
        yield* sync.syncNow;
        drive.onDownload = null;
        assert.strictEqual(yield* imac.read("Notes/plans.md"), "Typed on the iMac mid-sync\n");
        // The next pass sees both changes and keeps both.
        yield* sync.syncNow;
      }).pipe(Effect.provide(imac.layer));
      assert.strictEqual(yield* imac.read("Notes/plans.md"), "Plan v2 from Mac\n");
      const notes = yield* imac.fs.readDirectory(imac.path.join(imac.vault, "Notes"));
      const conflict = notes.find((name) => name.startsWith("plans (conflict iMac (bbbb) "));
      assert.isDefined(conflict);
      assert.strictEqual(yield* imac.read(`Notes/${conflict}`), "Typed on the iMac mid-sync\n");
    }),
  );

  it.effect("asks to sign in again when the saved sign-in stops working", () =>
    Effect.gen(function* () {
      const drive = new FakeOneDrive();
      const mac = yield* setup(drive, MAC);
      yield* Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        yield* secrets.set(
          "integration-microsoft-365--oauth",
          new TextEncoder().encode(toJson({ refreshToken: "plugin-rt" })),
        );
        yield* mac.registerDevice;
        const sync = yield* MemorySync.MemorySync;
        yield* sync.start;
        yield* sync.syncNow;
        assert.strictEqual((yield* sync.getStatus).sync.state, "idle");

        // Microsoft revokes the sign-in.
        drive.refreshTokens.clear();
        yield* sync.signOut;
        const settings = yield* ServerSettings.ServerSettingsService;
        assert.isFalse((yield* settings.getSettings).memorySyncEnabled);
        const restarted = yield* sync.start;
        assert.strictEqual(restarted.kind, "device_code");
      }).pipe(Effect.provide(mac.layer));
    }),
  );
});
