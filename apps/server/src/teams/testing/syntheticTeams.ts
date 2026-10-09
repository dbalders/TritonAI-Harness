import {
  type AccountStatus,
  type TeamCommand,
  type TeamRole,
  type TeamsResult,
  TeamsError,
  formatTeamNote,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { AccountService } from "../../auth/AccountService.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as TeamProject from "../TeamProjectService.ts";
import * as TeamStorage from "../TeamStorageService.ts";

/**
 * A synthetic campus membership service, Microsoft sign-in, and SharePoint drive for exercising
 * the real Teams services end to end. Nothing here reaches a network: the HTTP client answers
 * every request itself and records it in `trace`. All names, ids, and hosts are synthetic.
 */

const SYNTHETIC_TENANT_ID = "5e7e7e7e-0000-4000-a000-000000000001";
export const SYNTHETIC_OAUTH = {
  clientId: "5e7e7e7e-0000-4000-a000-000000000002",
  tenantId: SYNTHETIC_TENANT_ID,
};
const ISSUER = "https://synthetic-campus.invalid";
const SERVICE_URL = "https://synthetic-accounts.invalid";
/** Matches the SharePoint host pattern TeamStorage accepts; never contacted. */
const SYNTHETIC_SITE_HOST = "synthetic-fixture.sharepoint.com";

const SYNTHETIC_IDENTITIES = {
  owner: { subject: "synthetic-owner", displayName: "Synthetic Owner" },
  editor: { subject: "synthetic-editor", displayName: "Synthetic Editor" },
  reader: { subject: "synthetic-reader", displayName: "Synthetic Reader" },
  outsider: { subject: "synthetic-outsider", displayName: "Synthetic Outsider" },
} as const;
type SyntheticIdentity = keyof typeof SYNTHETIC_IDENTITIES;
const isSyntheticIdentity = (value: string): value is SyntheticIdentity =>
  Object.hasOwn(SYNTHETIC_IDENTITIES, value);
const emailOf = (identity: SyntheticIdentity) =>
  `${SYNTHETIC_IDENTITIES[identity].subject}@ucsd.edu`;
/** The author folder name the membership service gives a campus identity. */
const syntheticIdentityId = (identity: SyntheticIdentity) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([ISSUER, SYNTHETIC_IDENTITIES[identity].subject]))
    .digest("base64url");

export const SYNTHETIC_TEAMS = {
  alpha: {
    id: "a1a1a1a1-0000-4000-a000-000000000001",
    reference: "T-5A1FA001",
    name: "SYNTHETIC Alpha Team",
    driveId: "b!synthetic-alpha-drive",
    siteId: `${SYNTHETIC_SITE_HOST},a1a1a1a1-0000-4000-a000-0000000000a1,a1a1a1a1-0000-4000-a000-0000000000a2`,
    roles: { owner: "owner", editor: "editor", reader: "reader" },
  },
  beta: {
    id: "b2b2b2b2-0000-4000-a000-000000000002",
    reference: "T-5BE7A002",
    name: "SYNTHETIC Beta Team",
    driveId: "b!synthetic-beta-drive",
    siteId: `${SYNTHETIC_SITE_HOST},b2b2b2b2-0000-4000-a000-0000000000b1,b2b2b2b2-0000-4000-a000-0000000000b2`,
    roles: { owner: "owner" },
  },
} as const satisfies Record<
  string,
  {
    id: string;
    reference: string;
    name: string;
    driveId: string;
    siteId: string;
    roles: Partial<Record<SyntheticIdentity, TeamRole>>;
  }
>;
type SyntheticTeam = keyof typeof SYNTHETIC_TEAMS;
const isSyntheticTeam = (value: string): value is SyntheticTeam =>
  Object.hasOwn(SYNTHETIC_TEAMS, value);

const DEVICE_ID = "5e7e7e7e-0000-4000-a000-00000000de71";
const recordId = (n: number) => `5e7e7e7e-0000-4000-a000-${n.toString(16).padStart(12, "0")}`;

interface SeedDocument {
  readonly team: SyntheticTeam;
  readonly folder: "Memory" | "Skills";
  readonly author: SyntheticIdentity;
  readonly record: string;
  readonly text: string;
}
const SEED: readonly SeedDocument[] = [
  {
    team: "alpha",
    folder: "Memory",
    author: "owner",
    record: recordId(1),
    text: formatTeamNote({
      title: "SYNTHETIC grant report checklist",
      project: "synthetic-grant-reports",
      text: "Synthetic fixture note. Grant reports go out on the first Monday of each quarter.\n\n- Confirm the budget table totals.\n- Attach the **synthetic** milestone summary.",
    }),
  },
  {
    team: "alpha",
    folder: "Memory",
    author: "editor",
    record: recordId(2),
    text: formatTeamNote({
      title: "SYNTHETIC reviewer contacts",
      project: "synthetic-grant-reports",
      text: "Synthetic fixture note. Route draft reports to the synthetic reviewer queue before sending.",
    }),
  },
  {
    team: "alpha",
    folder: "Skills",
    author: "owner",
    record: recordId(3),
    text: formatTeamNote({
      title: "SYNTHETIC report formatter",
      description: "Formats a synthetic grant report summary as a short table.",
      project: "synthetic-grant-reports",
      text: "Synthetic fixture skill. Summarize the request as a two-column Markdown table (Item, Status) and keep it under ten rows.",
    }),
  },
  {
    team: "alpha",
    folder: "Skills",
    author: "editor",
    record: recordId(4),
    text: formatTeamNote({
      title: "SYNTHETIC hidden-character skill",
      description: "Contains a zero-width character; Harness should refuse to use it.",
      project: "synthetic-grant-reports",
      text: "Synthetic fixture skill with a hidden​ character.",
    }),
  },
  {
    team: "beta",
    folder: "Memory",
    author: "owner",
    record: recordId(5),
    text: formatTeamNote({
      title: "SYNTHETIC Beta-only note",
      project: "synthetic-beta",
      text: "Synthetic fixture note visible only to Beta members.",
    }),
  },
  {
    team: "beta",
    folder: "Skills",
    author: "owner",
    record: recordId(6),
    text: formatTeamNote({
      title: "SYNTHETIC Beta skill",
      description: "A Beta-only synthetic skill.",
      project: "synthetic-beta",
      text: "Synthetic fixture skill visible only to Beta members.",
    }),
  },
];
/** Seeded document paths, relative to each team root. */
export const syntheticDocumentPath = (index: number) => {
  const seed = SEED[index]!;
  return `${seed.folder}/${syntheticIdentityId(seed.author)}/${DEVICE_ID}/${seed.record}.md`;
};

interface SyntheticTraceEntry {
  readonly seq: number;
  readonly kind: "oauth" | "graph" | "download" | "blocked";
  readonly method: string;
  readonly host: string;
  /** Path only; query strings, tokens, and codes are never recorded. */
  readonly path: string;
  readonly team: SyntheticTeam | null;
  readonly identity: SyntheticIdentity | null;
  readonly status: number;
  readonly note?: string;
}

interface Item {
  readonly id: string;
  readonly driveId: string;
  name: string;
  parentId: string | null;
  readonly kind: "folder" | "file";
  text: string;
  version: number;
  /** Text a seeded document is restored to. */
  readonly seeded?: string;
}

const MAX_TRACE = 2_000;
const decodeFolder = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String })),
);
const encoder = new TextEncoder();
const fail = (code: TeamsError["code"], message: string) =>
  Effect.fail(new TeamsError({ code, message }));

/** Builds a fresh synthetic world: membership, Microsoft sign-in, and per-team drives. */
export function makeSyntheticTeamsWorld() {
  let current: SyntheticIdentity = "owner";
  let signedIn = true;
  // Device codes are issued only while armed, so an app-initiated sign-in never yields a Microsoft
  // URL a browser would open. `connectMicrosoft` arms it for the duration of its own flow.
  let deviceFlowArmed = 0;
  let counter = 0;
  const next = () => ++counter;
  const sessions = new Set<string>();
  const trace: SyntheticTraceEntry[] = [];
  const items = new Map<string, Item>();
  const accessTokens = new Map<string, SyntheticIdentity>();
  const refreshTokens = new Map<string, SyntheticIdentity>();
  const deviceCodes = new Map<string, SyntheticIdentity>();
  const downloads = new Map<string, { itemId: string; version: number }>();
  const teams = Object.fromEntries(
    Object.entries(SYNTHETIC_TEAMS).map(([key, team]) => [
      key,
      {
        ...team,
        key: key as SyntheticTeam,
        revision: 1,
        roles: new Map(Object.entries(team.roles)) as Map<SyntheticIdentity, TeamRole>,
        rootId: "",
        originalRootId: "",
        downloadHost: SYNTHETIC_SITE_HOST as string,
      },
    ]),
  ) as Record<
    SyntheticTeam,
    (typeof SYNTHETIC_TEAMS)[SyntheticTeam] & {
      key: SyntheticTeam;
      revision: number;
      roles: Map<SyntheticIdentity, TeamRole>;
      rootId: string;
      originalRootId: string;
      downloadHost: string;
    }
  >;
  const teamOfDrive = (driveId: string) =>
    Object.values(teams).find((team) => team.driveId === driveId) ?? null;
  const addItem = (item: Omit<Item, "id" | "version"> & { id?: string }) => {
    const id = item.id ?? `01SYNTH${next().toString().padStart(6, "0")}`;
    const created: Item = { ...item, id, version: 1 };
    items.set(id, created);
    return created;
  };
  const childNamed = (parentId: string, name: string) =>
    [...items.values()].find((item) => item.parentId === parentId && item.name === name);
  const ensureFolder = (driveId: string, parentId: string, name: string) =>
    childNamed(parentId, name) ?? addItem({ driveId, name, parentId, kind: "folder", text: "" });
  for (const team of Object.values(teams)) {
    const driveRoot = addItem({
      id: `01SYNTHROOT-${team.key}`,
      driveId: team.driveId,
      name: "root",
      parentId: null,
      kind: "folder",
      text: "",
    });
    const root = addItem({
      id: `01SYNTHTEAM-${team.key}`,
      driveId: team.driveId,
      name: team.name,
      parentId: driveRoot.id,
      kind: "folder",
      text: "",
    });
    team.rootId = root.id;
    team.originalRootId = root.id;
  }
  const seedPaths: Array<{ team: SyntheticTeam; path: string }> = [];
  SEED.forEach((seed, index) => {
    const team = teams[seed.team];
    const path = syntheticDocumentPath(index);
    const parts = path.split("/");
    let parentId = team.rootId;
    for (const name of parts.slice(0, -1)) parentId = ensureFolder(team.driveId, parentId, name).id;
    addItem({
      driveId: team.driveId,
      name: parts.at(-1)!,
      parentId,
      kind: "file",
      text: seed.text,
      seeded: seed.text,
    });
    seedPaths.push({ team: seed.team, path });
  });

  const record = (entry: Omit<SyntheticTraceEntry, "seq">) => {
    trace.push({ seq: next(), ...entry });
    if (trace.length > MAX_TRACE) trace.splice(0, trace.length - MAX_TRACE);
  };
  const profile = (identity: SyntheticIdentity) => ({
    issuer: ISSUER,
    subject: SYNTHETIC_IDENTITIES[identity].subject,
    email: emailOf(identity),
    displayName: `${SYNTHETIC_IDENTITIES[identity].displayName} (synthetic)`,
  });
  const status = (): AccountStatus => ({
    configured: true,
    status: signedIn ? "signed-in" : "signed-out",
    serviceUrl: SERVICE_URL,
    profile: signedIn ? profile(current) : null,
    expiresAt: signedIn ? 4_102_444_800 : null,
    verificationUrl: null,
    userCode: null,
    pollIntervalSeconds: null,
  });
  const detail = (team: (typeof teams)[SyntheticTeam], role: TeamRole) => ({
    id: team.id,
    reference: team.reference,
    name: team.name,
    role,
    canManage: role === "owner",
    revision: team.revision,
    state: "ready" as const,
    members: [...team.roles].map(([identity, memberRole]) => ({
      identityId: syntheticIdentityId(identity),
      displayName: SYNTHETIC_IDENTITIES[identity].displayName,
      email: emailOf(identity),
      role: memberRole,
    })),
    invitations: [],
    storage: {
      tenantId: SYNTHETIC_TENANT_ID,
      siteId: team.siteId,
      driveId: team.driveId,
      folderId: team.rootId,
    },
  });
  const memberTeams = () =>
    Object.values(teams).flatMap((team) => {
      const role = team.roles.get(current);
      return role ? [{ team, role }] : [];
    });
  const identityOfMember = (team: (typeof teams)[SyntheticTeam], identityId: string) =>
    [...team.roles.keys()].find((identity) => syntheticIdentityId(identity) === identityId);

  /** Membership commands as the campus service answers them, over the synthetic state. */
  const teamsCommand = (command: TeamCommand): Effect.Effect<TeamsResult, TeamsError> =>
    Effect.suspend(() => {
      if (!signedIn) return fail("sign_in_required", "Sign in with UC San Diego to use Teams.");
      const result = (team: TeamsResult["team"]): TeamsResult => ({
        teams: memberTeams().map(({ team: entry, role }) => {
          const { members: _m, invitations: _i, storage: _s, ...summary } = detail(entry, role);
          return summary;
        }),
        invitations: [],
        team,
        invitationCode: null,
      });
      if (command.action === "list") return Effect.succeed(result(null));
      if (!("teamId" in command))
        return fail("invalid_request", "Invitations are disabled in the synthetic Teams fixture.");
      const team = Object.values(teams).find((entry) => entry.id === command.teamId);
      const role = team?.roles.get(current);
      if (!team || !role) return fail("not_found", "Team unavailable");
      if (command.action === "get") return Effect.succeed(result(detail(team, role)));
      if (command.action === "invite")
        return fail("invalid_request", "This action is disabled in the synthetic Teams fixture.");
      if ("revision" in command && command.revision !== team.revision)
        return fail("conflict", "This team changed. Refresh and try again.");
      if (command.action === "leave") {
        if (role === "owner" && [...team.roles.values()].filter((r) => r === "owner").length < 2)
          return fail("conflict", "A team needs at least one owner.");
        team.roles.delete(current);
        team.revision++;
        return Effect.succeed(result(null));
      }
      if (role !== "owner") return fail("forbidden", "Only team owners can do this.");
      if (command.action === "set-role" || command.action === "remove-member") {
        const member = identityOfMember(team, command.identityId);
        if (!member) return fail("not_found", "Member unavailable");
        if (command.action === "set-role") team.roles.set(member, command.role);
        else team.roles.delete(member);
        team.revision++;
        const after = team.roles.get(current);
        return Effect.succeed(result(after ? detail(team, after) : null));
      }
      return fail("invalid_request", "This action is disabled in the synthetic Teams fixture.");
    });

  const account = AccountService.of({
    getStatus: (sessionId) =>
      Effect.sync(() => {
        sessions.add(sessionId);
        return status();
      }),
    startLogin: (sessionId) =>
      Effect.sync(() => {
        sessions.add(sessionId);
        signedIn = true;
        return status();
      }),
    pollLogin: () => Effect.sync(status),
    signOut: () =>
      Effect.sync(() => {
        signedIn = false;
        return status();
      }),
    teams: (sessionId, command) =>
      Effect.suspend(() => {
        sessions.add(sessionId);
        return teamsCommand(command);
      }),
  });

  const itemJson = (item: Item, withDownload: boolean) => {
    const team = teamOfDrive(item.driveId)!;
    let download: string | undefined;
    if (withDownload && item.kind === "file") {
      const token = `synthetic-download-${next()}`;
      downloads.set(token, { itemId: item.id, version: item.version });
      download = `https://${team.downloadHost}/_layouts/15/download.aspx?UniqueId=${encodeURIComponent(item.id)}&tempauth=${token}`;
    }
    return {
      id: item.id,
      name: item.name,
      eTag: `"{${item.id}},${item.version}"`,
      size: encoder.encode(item.text).byteLength,
      parentReference: { id: item.parentId ?? "", driveId: item.driveId },
      ...(item.kind === "folder"
        ? {
            folder: {
              childCount: [...items.values()].filter((c) => c.parentId === item.id).length,
            },
          }
        : { file: { mimeType: "text/markdown" } }),
      ...(download ? { "@microsoft.graph.downloadUrl": download } : {}),
    };
  };
  const itemPath =
    /^\/v1\.0\/drives\/([^/]+)\/items\/([^/:]+)(?::\/(.+?))?(:\/children|:\/content|\/children)?$/u;

  const http = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const respond = (body: unknown, statusCode = 200) =>
        HttpClientResponse.fromWeb(
          request,
          body === null
            ? new Response(null, { status: statusCode })
            : Response.json(body, { status: statusCode }),
        );
      const graphError = (statusCode: number, code: string) =>
        respond({ error: { code, message: `Synthetic Graph: ${code}` } }, statusCode);
      const bodyText = () =>
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      const base = { method: request.method, host: url.hostname, path: url.pathname };
      const bearer = request.headers.authorization?.replace(/^Bearer /u, "") ?? "";

      if (url.protocol !== "https:") {
        record({ ...base, kind: "blocked", team: null, identity: null, status: 502 });
        return respond({ error: "synthetic_fixture_blocked" }, 502);
      }

      if (url.hostname === "login.microsoftonline.com") {
        const form = new URLSearchParams(bodyText());
        const oauth = (statusCode: number, body: unknown, note?: string) => {
          record({
            ...base,
            kind: "oauth",
            team: null,
            identity: null,
            status: statusCode,
            ...(note ? { note } : {}),
          });
          return respond(body, statusCode);
        };
        if (
          !url.pathname.startsWith(`/${SYNTHETIC_TENANT_ID}/oauth2/v2.0/`) ||
          form.get("client_id") !== SYNTHETIC_OAUTH.clientId
        )
          return oauth(400, { error: "invalid_client" }, "wrong tenant or client");
        if (url.pathname.endsWith("/devicecode")) {
          if (deviceFlowArmed === 0)
            return oauth(
              400,
              {
                error: "invalid_request",
                error_description:
                  "Synthetic Teams fixture: connect Microsoft with the fixture control 'connect-microsoft' action.",
              },
              "device flow not armed",
            );
          const code = `synthetic-device-${next()}`;
          deviceCodes.set(code, current);
          return oauth(200, {
            device_code: code,
            user_code: "SYNTHFIX",
            verification_uri: "https://microsoft.com/devicelogin",
            expires_in: 600,
            interval: 1,
          });
        }
        if (url.pathname.endsWith("/token")) {
          const grant = form.get("grant_type");
          const identity =
            grant === "refresh_token"
              ? refreshTokens.get(form.get("refresh_token") ?? "")
              : deviceCodes.get(form.get("device_code") ?? "");
          if (!identity) return oauth(400, { error: "invalid_grant" }, `rejected ${grant}`);
          if (grant !== "refresh_token") deviceCodes.delete(form.get("device_code") ?? "");
          const access = `synthetic-graph-access-${next()}`;
          const refresh = `synthetic-graph-refresh-${next()}`;
          accessTokens.set(access, identity);
          refreshTokens.set(refresh, identity);
          return oauth(
            200,
            {
              access_token: access,
              refresh_token: refresh,
              expires_in: 3600,
              token_type: "Bearer",
            },
            `issued ${grant} for ${identity}`,
          );
        }
        return oauth(404, { error: "not_found" });
      }

      if (url.hostname === SYNTHETIC_SITE_HOST || url.hostname.endsWith(".sharepoint.com")) {
        const token = url.searchParams.get("tempauth") ?? "";
        const grant = downloads.get(token);
        const item = grant ? items.get(grant.itemId) : undefined;
        const team = item ? teamOfDrive(item.driveId) : null;
        const download = (statusCode: number, note: string, body?: string) => {
          record({
            ...base,
            kind: "download",
            team: team?.key ?? null,
            identity: null,
            status: statusCode,
            note,
          });
          return HttpClientResponse.fromWeb(
            request,
            new Response(body ?? null, { status: statusCode }),
          );
        };
        // A signed download URL carries its own authorization; a Graph bearer must never follow it.
        if (request.headers.authorization) return download(400, "bearer sent to download host");
        if (url.hostname !== SYNTHETIC_SITE_HOST || !team || url.hostname !== team.downloadHost)
          return download(404, "unknown download host");
        if (!item || item.version !== grant!.version) return download(410, "stale download URL");
        return download(200, "served", item.text);
      }

      if (url.hostname !== "graph.microsoft.com") {
        record({ ...base, kind: "blocked", team: null, identity: null, status: 502 });
        return respond({ error: "synthetic_fixture_blocked" }, 502);
      }
      const identity = accessTokens.get(bearer) ?? null;
      if (url.pathname === "/v1.0/me") {
        record({ ...base, kind: "graph", team: null, identity, status: identity ? 200 : 401 });
        if (!identity) return graphError(401, "InvalidAuthenticationToken");
        return respond({
          id: `${SYNTHETIC_IDENTITIES[identity].subject}-entra-object`,
          userPrincipalName: emailOf(identity),
          mail: emailOf(identity),
          userType: "Member",
        });
      }
      const match = itemPath.exec(url.pathname);
      const team = match ? teamOfDrive(decodeURIComponent(match[1]!)) : null;
      const graph = (statusCode: number, note?: string) =>
        record({
          ...base,
          kind: "graph",
          team: team?.key ?? null,
          identity,
          status: statusCode,
          ...(note ? { note } : {}),
        });
      if (!identity) {
        graph(401);
        return graphError(401, "InvalidAuthenticationToken");
      }
      if (!match || !team) {
        graph(404, "unknown drive or route");
        return graphError(404, "itemNotFound");
      }
      // Stands in for the team folder's SharePoint permissions: members only, readers read-only.
      const role = team.roles.get(identity);
      if (!role) {
        graph(403, "not a member of the drive's team");
        return graphError(403, "accessDenied");
      }
      const writing = request.method !== "GET";
      if (writing && role === "reader") {
        graph(403, "reader cannot write");
        return graphError(403, "accessDenied");
      }
      const anchor = items.get(decodeURIComponent(match[2]!));
      if (!anchor || anchor.driveId !== team.driveId) {
        graph(404, "item is not in this drive");
        return graphError(404, "itemNotFound");
      }
      const names = match[3] ? match[3].split("/").map(decodeURIComponent) : [];
      const suffix = match[4];
      const resolve = (segments: string[]) => {
        let at: Item | undefined = anchor;
        for (const name of segments) at = at && childNamed(at.id, name);
        return at;
      };
      const target = resolve(names);
      if (suffix === ":/content" && request.method === "PUT") {
        const parent = resolve(names.slice(0, -1));
        if (!parent || parent.kind !== "folder") {
          graph(404, "parent folder missing");
          return graphError(404, "itemNotFound");
        }
        const ifMatch = request.headers["if-match"];
        if (target) {
          if (url.searchParams.get("@microsoft.graph.conflictBehavior") === "fail") {
            graph(409, "exists");
            return graphError(409, "nameAlreadyExists");
          }
          if (ifMatch !== undefined && ifMatch !== itemJson(target, false).eTag) {
            graph(412, "stale eTag");
            return graphError(412, "preconditionFailed");
          }
          target.text = bodyText();
          target.version++;
          graph(200, "updated");
          return respond(itemJson(target, false));
        }
        if (ifMatch !== undefined) {
          graph(404, "update of a missing file");
          return graphError(404, "itemNotFound");
        }
        const created = addItem({
          driveId: team.driveId,
          name: names.at(-1)!,
          parentId: parent.id,
          kind: "file",
          text: bodyText(),
        });
        graph(201, "created");
        return respond(itemJson(created, false), 201);
      }
      if (suffix?.endsWith("children") && request.method === "POST") {
        if (!target || target.kind !== "folder") {
          graph(404, "parent folder missing");
          return graphError(404, "itemNotFound");
        }
        const name = Option.getOrUndefined(decodeFolder(bodyText()))?.name;
        if (!name || name.includes("/")) {
          graph(400, "invalid folder name");
          return graphError(400, "invalidRequest");
        }
        if (childNamed(target.id, name)) {
          graph(409, "folder exists");
          return graphError(409, "nameAlreadyExists");
        }
        const created = addItem({
          driveId: team.driveId,
          name,
          parentId: target.id,
          kind: "folder",
          text: "",
        });
        graph(201, "folder created");
        return respond(itemJson(created, false), 201);
      }
      if (request.method === "DELETE" && !suffix) {
        if (!target) {
          graph(404);
          return graphError(404, "itemNotFound");
        }
        const ifMatch = request.headers["if-match"];
        if (ifMatch !== undefined && ifMatch !== itemJson(target, false).eTag) {
          graph(412, "stale eTag");
          return graphError(412, "preconditionFailed");
        }
        items.delete(target.id);
        graph(204, "deleted");
        return respond(null, 204);
      }
      if (request.method !== "GET" || suffix === ":/content") {
        graph(405);
        return graphError(405, "notSupported");
      }
      if (!target) {
        graph(404);
        return graphError(404, "itemNotFound");
      }
      if (suffix?.endsWith("children")) {
        const children = [...items.values()].filter((item) => item.parentId === target.id);
        const top = Math.min(Number(url.searchParams.get("$top") ?? 200) || 200, 200);
        const skip = Number(url.searchParams.get("$skiptoken") ?? 0) || 0;
        const page = children.slice(skip, skip + top);
        const nextLink =
          skip + top < children.length
            ? (() => {
                const link = new URL(url.href);
                link.searchParams.set("$skiptoken", String(skip + top));
                return link.href;
              })()
            : undefined;
        graph(200, `children ${page.length}`);
        return respond({
          value: page.map((item) => itemJson(item, false)),
          ...(nextLink ? { "@odata.nextLink": nextLink } : {}),
        });
      }
      graph(200);
      return respond(itemJson(target, true));
    }),
  );

  const documentAt = (team: SyntheticTeam, path: string) => {
    const root = items.get(teams[team].rootId);
    let at: Item | undefined = root;
    for (const name of path.split("/")) at = at && childNamed(at.id, name);
    return at?.kind === "file" ? at : undefined;
  };
  const teamOrFail = (team: string) => {
    if (!isSyntheticTeam(team)) throw new Error(`Unknown synthetic team "${team}".`);
    return teams[team];
  };
  const identityOrFail = (identity: string) => {
    if (!isSyntheticIdentity(identity))
      throw new Error(`Unknown synthetic identity "${identity}".`);
    return identity;
  };

  return {
    account,
    http,
    trace,
    sessions,
    seedPaths,
    /** Plain state for a control or test to show; never includes tokens. */
    snapshot: () => ({
      identity: current,
      signedIn,
      sessions: sessions.size,
      microsoftConnections: accessTokens.size,
      teams: Object.values(teams).map((team) => ({
        key: team.key,
        id: team.id,
        name: team.name,
        revision: team.revision,
        driveId: team.driveId,
        rootId: team.rootId,
        downloadHost: team.downloadHost,
        members: Object.fromEntries(team.roles),
      })),
      documents: Object.values(teams).flatMap((team) =>
        [...items.values()]
          .filter((item) => item.kind === "file" && item.driveId === team.driveId)
          .map((item) => ({
            team: team.key,
            id: item.id,
            name: item.name,
            eTag: itemJson(item, false).eTag,
            edited: item.seeded !== undefined && item.seeded !== item.text,
          })),
      ),
    }),
    switchTo: (identity: string) => {
      current = identityOrFail(identity);
      signedIn = true;
    },
    signOut: () => {
      signedIn = false;
    },
    signIn: () => {
      signedIn = true;
    },
    /** Sets or removes (role `none`) a member, as an owner's action on the membership service would. */
    setRole: (team: string, identity: string, role: TeamRole | "none") => {
      const entry = teamOrFail(team);
      const member = identityOrFail(identity);
      if (role === "none") entry.roles.delete(member);
      else entry.roles.set(member, role);
      entry.revision++;
    },
    /** Points the team at a different folder, as a reprovisioned team would. */
    moveRoot: (team: string) => {
      const entry = teamOrFail(team);
      const root = items.get(entry.originalRootId)!;
      const moved = addItem({
        driveId: entry.driveId,
        name: `${entry.name} (moved)`,
        parentId: root.parentId,
        kind: "folder",
        text: "",
      });
      entry.rootId = moved.id;
      entry.revision++;
    },
    restoreRoot: (team: string) => {
      const entry = teamOrFail(team);
      entry.rootId = entry.originalRootId;
      entry.revision++;
    },
    /** Serves download URLs on another host, which TeamStorage must refuse before fetching. */
    setDownloadHost: (team: string, host: string) => {
      teamOrFail(team).downloadHost = host;
    },
    editDocument: (team: string, path: string, text: string) => {
      const item = documentAt(teamOrFail(team).key, path);
      if (!item) throw new Error("No synthetic document at that path.");
      item.text = text;
      item.version++;
    },
    restoreDocument: (team: string, path: string) => {
      const item = documentAt(teamOrFail(team).key, path);
      if (!item?.seeded) throw new Error("No seeded synthetic document at that path.");
      item.text = item.seeded;
      item.version++;
    },
    readDocument: (team: string, path: string) => documentAt(teamOrFail(team).key, path)?.text,
    /** Runs `effect` while app-initiated device codes are allowed. */
    withDeviceFlow: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => void deviceFlowArmed++),
        () => effect,
        () => Effect.sync(() => void deviceFlowArmed--),
      ),
    teamId: (team: string) => teamOrFail(team).id,
  };
}
type SyntheticTeamsWorld = ReturnType<typeof makeSyntheticTeamsWorld>;

/** The real TeamStorage and TeamProject services over a synthetic world's account and HTTP client. */
export const makeSyntheticTeamServices = (world: SyntheticTeamsWorld) =>
  Effect.gen(function* () {
    const storage = yield* TeamStorage.make(SYNTHETIC_OAUTH).pipe(
      Effect.provideService(AccountService, world.account),
      Effect.provideService(HttpClient.HttpClient, world.http),
    );
    const project = yield* TeamProject.make.pipe(
      Effect.provideService(AccountService, world.account),
      Effect.provideService(TeamStorage.TeamStorageService, storage),
    );
    /** Connects Microsoft for every app session the account service has seen, as the current identity. */
    const connectMicrosoft = Effect.gen(function* () {
      const teamId = world
        .snapshot()
        .teams.find((team) => team.members[world.snapshot().identity])?.id;
      if (!teamId) return yield* fail("not_found", "The current identity has no team.");
      let connected = 0;
      for (const sessionId of world.sessions) {
        yield* world.withDeviceFlow(
          Effect.gen(function* () {
            const flow = yield* storage.execute(sessionId, { action: "connect", teamId });
            if (flow.flowId)
              yield* storage.execute(sessionId, { action: "poll", teamId, flowId: flow.flowId });
          }),
        );
        connected++;
      }
      return connected;
    });
    return { account: world.account, storage, project, connectMicrosoft };
  });
export type SyntheticTeamServices = Effect.Success<ReturnType<typeof makeSyntheticTeamServices>>;

/**
 * Account, TeamStorage, and TeamProject services for the server routes, built once over `world`.
 * `onReady` receives the instances so a fixture control can drive the same services.
 */
export const syntheticTeamServicesLayer = (
  world: SyntheticTeamsWorld,
  onReady: (services: SyntheticTeamServices) => void = () => {},
) =>
  Layer.effectContext(
    makeSyntheticTeamServices(world).pipe(
      Effect.tap((services) => Effect.sync(() => onReady(services))),
      Effect.map((services) =>
        Context.make(AccountService, services.account).pipe(
          Context.add(TeamStorage.TeamStorageService, services.storage),
          Context.add(TeamProject.TeamProjectService, services.project),
        ),
      ),
    ),
  ).pipe(Layer.provide(ServerSecretStore.layer));
