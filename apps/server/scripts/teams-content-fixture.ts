#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off preferSchemaOverJson:off - dev-only launcher; plain Node around one Effect server program.
/**
 * Synthetic Teams content fixture: the real Harness server (HTTP + WebSocket routes, orchestration,
 * TeamProjectService, TeamStorageService) with only the campus account service, Microsoft sign-in,
 * SharePoint/Graph, and the agent replaced by local synthetic stand-ins. Stop it by sending SIGTERM
 * to the printed pid; that stops the server, its provider processes, and the web dev server.
 *
 *   T3_TEAMS_CONTENT_FIXTURE=1 node apps/server/scripts/teams-content-fixture.ts start \
 *     --home-dir <new absolute dir> --port <server port> --web-port <web port> [--no-web]
 *   node apps/server/scripts/teams-content-fixture.ts control --home-dir <dir> <action> [args]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  fixtureHomeProblem,
  fixtureLayout,
  fixturePortProblem,
  fixtureServerEnvironment,
  prepareFixtureHome,
} from "../src/teams/testing/contentFixtureHome.ts";
import type { SyntheticTeamServices } from "../src/teams/testing/syntheticTeams.ts";
import type { TeamRole } from "@t3tools/contracts";

const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const sourceRoot = NodePath.resolve(scriptDir, "../../..");
const mockAgentScript = NodePath.join(scriptDir, "acp-mock-agent.ts");
const prefix = "[teams-content-fixture]";

const usage = `Usage:
  T3_TEAMS_CONTENT_FIXTURE=1 node apps/server/scripts/teams-content-fixture.ts start --home-dir <new absolute dir> --port <server port> --web-port <web port> [--no-web]
  node apps/server/scripts/teams-content-fixture.ts control --home-dir <dir> <action> [key=value ...]

Control actions:
  state | trace [since=<seq>] | sent | connect-microsoft
  switch identity=<owner|editor|reader|outsider> | sign-out | sign-in
  set-role team=<alpha|beta> identity=<...> role=<owner|editor|reader|none>
  edit team=<...> path=<Memory/...md> text=<new text> | restore team=<...> path=<...> | read team=<...> path=<...>
  move-root team=<...> | restore-root team=<...> | download-host team=<...> host=<hostname>
  unarchive team=<...>`;

const fail = (message: string): never => {
  process.stderr.write(`${prefix} ${message}\n`);
  process.exit(2);
};

function parse(args: readonly string[]) {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--no-web") flags.set("no-web", true);
    else if (arg.startsWith("--")) {
      const value = args[++index];
      if (value === undefined) fail(`${arg} needs a value.`);
      flags.set(arg.slice(2), value!);
    } else rest.push(arg);
  }
  return { flags, rest };
}

const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const probe = NodeNet.createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ port, host: "127.0.0.1" }, () => probe.close(() => resolve(true)));
  });

function findOnPath(name: string, path: string | undefined) {
  for (const dir of (path ?? "").split(NodePath.delimiter)) {
    const candidate = NodePath.join(dir, name);
    if (dir && NodeFS.existsSync(candidate)) return candidate;
  }
  return null;
}

async function start(flags: Map<string, string | true>) {
  if (process.env.T3_TEAMS_CONTENT_FIXTURE !== "1")
    fail("This synthetic fixture starts only with T3_TEAMS_CONTENT_FIXTURE=1.");
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) fail("Refusing to run inside Lambda.");
  if (flags.has("host")) fail("The fixture always binds 127.0.0.1; --host is not accepted.");
  const home = flags.get("home-dir");
  if (typeof home !== "string") fail("--home-dir is required.");
  const homeProblem = fixtureHomeProblem(home as string, { sourceRoot });
  if (homeProblem) fail(homeProblem);
  const noWeb = flags.get("no-web") === true;
  const port = Number(flags.get("port"));
  const webPort = noWeb ? null : Number(flags.get("web-port"));
  const portProblem = fixturePortProblem(port, webPort);
  if (portProblem) fail(portProblem);
  for (const candidate of [port, ...(webPort === null ? [] : [webPort])])
    if (!(await portFree(candidate))) fail(`Port ${candidate} is already in use on 127.0.0.1.`);

  const layout = prepareFixtureHome(NodePath.resolve(home as string), mockAgentScript);
  const inherited = { ...process.env };

  // Web first, from the caller's environment: Vite serves the UI and proxies /api and /ws here.
  let web: NodeChildProcess.ChildProcess | null = null;
  if (webPort !== null) {
    const vp = findOnPath("vp", inherited.PATH);
    if (!vp) fail("`vp` is not on PATH; start with --no-web or add Vite+ to PATH.");
    const webEnv: NodeJS.ProcessEnv = {
      ...inherited,
      PORT: String(webPort),
      T3CODE_PORT: String(port),
      T3CODE_SINGLE_ORIGIN_DEV: "1",
    };
    for (const name of ["VITE_HTTP_URL", "VITE_WS_URL", "HOST", "T3CODE_DEV_AUTH_TOKEN"])
      delete webEnv[name];
    web = NodeChildProcess.spawn(vp!, ["dev"], {
      cwd: NodePath.join(sourceRoot, "apps/web"),
      env: webEnv,
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    });
    web.once("exit", (code, signal) =>
      process.stderr.write(`${prefix} web dev server exited (${code ?? signal}).\n`),
    );
  }

  // The server and everything it spawns see only the fixture's private environment.
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(
    process.env,
    fixtureServerEnvironment(layout, inherited, NodePath.dirname(process.execPath)),
  );

  const [
    { makeSyntheticTeamsWorld, syntheticTeamServicesLayer },
    { runServer, ServerTeamServices },
    { resolveServerConfig },
    { ServerConfig },
    NodeRuntime,
    NodeServices,
    NetService,
    Effect,
    Layer,
    Option,
  ] = await Promise.all([
    import("../src/teams/testing/syntheticTeams.ts"),
    import("../src/server.ts"),
    import("../src/cli/config.ts"),
    import("../src/config.ts"),
    import("@effect/platform-node/NodeRuntime"),
    import("@effect/platform-node/NodeServices"),
    import("@t3tools/shared/Net"),
    import("effect/Effect"),
    import("effect/Layer"),
    import("effect/Option"),
  ]);
  const world = makeSyntheticTeamsWorld();
  let services: SyntheticTeamServices | null = null;
  const teamServices = syntheticTeamServicesLayer(world, (ready) => {
    services = ready;
  });

  const control = startControl(layout.controlFile, async (request) => {
    const { action, ...args } = request;
    const text = (name: string) => {
      const value = args[name];
      if (typeof value !== "string" || !value) throw new Error(`${name}=... is required.`);
      return value;
    };
    switch (action) {
      case "state":
        return { ...world.snapshot(), seededPaths: world.seedPaths };
      case "trace": {
        const since = Number(args.since ?? 0) || 0;
        return world.trace.filter((entry) => entry.seq > since);
      }
      case "sent":
        return readProviderPrompts(layout.providerRequestLog);
      case "connect-microsoft": {
        if (!services) throw new Error("The server has not built its Teams services yet.");
        const connected = await Effect.runPromise(
          (services as SyntheticTeamServices).connectMicrosoft,
        );
        return { connectedSessions: connected };
      }
      case "switch":
        world.switchTo(text("identity"));
        break;
      case "sign-out":
        world.signOut();
        break;
      case "sign-in":
        world.signIn();
        break;
      case "set-role": {
        const role = text("role");
        if (!["owner", "editor", "reader", "none"].includes(role))
          throw new Error("role must be owner, editor, reader, or none.");
        world.setRole(text("team"), text("identity"), role as TeamRole | "none");
        break;
      }
      case "edit":
        world.editDocument(text("team"), text("path"), text("text"));
        break;
      case "restore":
        world.restoreDocument(text("team"), text("path"));
        break;
      case "read":
        return { text: world.readDocument(text("team"), text("path")) ?? null };
      case "move-root":
        world.moveRoot(text("team"));
        break;
      case "restore-root":
        world.restoreRoot(text("team"));
        break;
      case "unarchive":
        world.unarchive(text("team"));
        break;
      case "download-host":
        world.setDownloadHost(text("team"), text("host"));
        break;
      default:
        throw new Error(`Unknown action. ${usage}`);
    }
    return world.snapshot();
  });

  const cleanup = () => {
    control.close();
    if (web?.pid !== undefined && web.exitCode === null) {
      try {
        process.kill(-web.pid, "SIGTERM");
      } catch {}
    }
  };
  process.once("exit", cleanup);
  await control.listening;
  NodeFS.writeFileSync(
    layout.controlFile,
    `${JSON.stringify({ socketPath: control.socketPath, pid: process.pid, webPid: web?.pid ?? null, port, webPort }, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(
    [
      `${prefix} SYNTHETIC TEST FIXTURE. Synthetic campus accounts, Microsoft, SharePoint, and agent; no real services.`,
      `${prefix} pid=${process.pid} webPid=${web?.pid ?? "none"} server=http://127.0.0.1:${port}${webPort === null ? "" : ` web=http://localhost:${webPort}`}`,
      `${prefix} home=${layout.home}`,
      `${prefix} Stop with: kill -TERM ${process.pid}`,
      "",
    ].join("\n"),
  );

  const program = Effect.gen(function* () {
    const config = yield* resolveServerConfig(
      {
        mode: Option.some("web" as const),
        port: Option.some(port),
        host: Option.some("127.0.0.1"),
        baseDir: Option.some(layout.baseDir),
        cwd: Option.some(layout.workspace),
        devUrl:
          webPort === null ? Option.none() : Option.some(new URL(`http://localhost:${webPort}/`)),
        noBrowser: Option.some(true),
        bootstrapFd: Option.none(),
        autoBootstrapProjectFromCwd: Option.some(true),
        logWebSocketEvents: Option.none(),
        tailscaleServeEnabled: Option.some(false),
        tailscaleServePort: Option.none(),
      },
      Option.none(),
    );
    if (config.host !== "127.0.0.1" || config.baseDir !== layout.baseDir)
      return yield* Effect.die(new Error("Fixture server configuration escaped its isolation."));
    return yield* runServer.pipe(
      Effect.provideService(ServerConfig, config),
      Effect.provideService(ServerTeamServices, teamServices),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)));
  NodeRuntime.runMain(program);
}

/** A loopback-only control endpoint on a private Unix socket; filesystem permissions are its auth. */
function startControl(
  controlFile: string,
  handle: (request: Record<string, unknown>) => Promise<unknown>,
) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-teams-fixture-"));
  NodeFS.chmodSync(dir, 0o700);
  const socketPath = NodePath.join(dir, "control.sock");
  const server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 256 * 1024) request.destroy();
    });
    request.on("end", () => {
      const reply = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(`${JSON.stringify(value, null, 2)}\n`);
      };
      if (request.method !== "POST" || request.url !== "/control") return reply(404, {});
      Promise.resolve()
        .then(() => handle(JSON.parse(body || "{}") as Record<string, unknown>))
        .then(
          (value) => reply(200, value ?? { ok: true }),
          (error: unknown) =>
            reply(400, { error: error instanceof Error ? error.message : String(error) }),
        );
    });
  });
  const listening = new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    listening,
    close: () => {
      server.close();
      NodeFS.rmSync(dir, { recursive: true, force: true });
      NodeFS.rmSync(controlFile, { force: true });
    },
  };
}

/**
 * Each prompt the synthetic provider received, oldest first. Thread-title generation also runs on
 * the selected provider, so those prompts are labeled apart from user messages.
 */
function readProviderPrompts(logPath: string) {
  if (!NodeFS.existsSync(logPath)) return [];
  return NodeFS.readFileSync(logPath, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        const message = JSON.parse(line) as {
          method?: string;
          params?: { prompt?: Array<{ type?: string; text?: string }> };
        };
        if (message.method !== "session/prompt") return [];
        const text = (message.params?.prompt ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n");
        return [
          { kind: text.startsWith("Generate a title") ? "title-generation" : "message", text },
        ];
      } catch {
        return [];
      }
    });
}

async function control(flags: Map<string, string | true>, rest: readonly string[]) {
  const home = flags.get("home-dir");
  if (typeof home !== "string") fail("--home-dir is required.");
  const [action, ...pairs] = rest;
  if (!action) fail(usage);
  const controlFile = fixtureLayout(NodePath.resolve(home as string)).controlFile;
  if (!NodeFS.existsSync(controlFile)) fail("No running fixture found for that --home-dir.");
  const { socketPath } = JSON.parse(NodeFS.readFileSync(controlFile, "utf8")) as {
    socketPath: string;
  };
  const body: Record<string, string> = { action: action! };
  for (const pair of pairs) {
    const split = pair.indexOf("=");
    if (split < 1) fail(`Expected key=value, got "${pair}".`);
    body[pair.slice(0, split)] = pair.slice(split + 1);
  }
  const result = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const request = NodeHttp.request(
      {
        socketPath,
        path: "/control",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
  process.stdout.write(result.text);
  process.exit(result.status === 200 ? 0 : 1);
}

const [command, ...args] = process.argv.slice(2);
const { flags, rest } = parse(args);
if (command === "start") await start(flags);
else if (command === "control") await control(flags, rest);
else fail(usage);
