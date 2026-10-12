// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off - synchronous setup for a dev-only fixture launcher, before any Effect runtime exists.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { writeFakeCli, execScriptSource } from "../../testUtils/fakeCli.ts";

/**
 * Layout and safety checks for the synthetic Teams content fixture home. The launcher refuses any
 * directory it did not create, so it can never start against real Harness, provider, or
 * account state.
 */
export const FIXTURE_MARKER = ".synthetic-teams-content-fixture";
const PROVIDER_REPLY =
  "SYNTHETIC fixture reply: the deterministic test provider received this message. No model, provider account, or network was used.";
/** Provider CLIs a fixture server must never run; each resolves to a stub that refuses. */
const BLOCKED_CLIS = [
  "codex",
  "claude",
  "cursor-agent",
  "agent",
  "grok",
  "opencode",
  "antigravity",
];

interface FixtureLayout {
  readonly home: string;
  readonly baseDir: string;
  readonly settingsPath: string;
  readonly keyringPath: string;
  readonly userHome: string;
  readonly binDir: string;
  readonly cursorAgentPath: string;
  readonly providerRequestLog: string;
  readonly blockedCliLog: string;
  readonly workspace: string;
  readonly controlFile: string;
  readonly codexHome: string;
}

export const fixtureLayout = (home: string): FixtureLayout => {
  const fixture = NodePath.join(home, "fixture");
  return {
    home,
    baseDir: NodePath.join(home, "t3"),
    settingsPath: NodePath.join(home, "t3", "userdata", "settings.json"),
    keyringPath: NodePath.join(fixture, "keyring.json"),
    userHome: NodePath.join(home, "user-home"),
    binDir: NodePath.join(fixture, "bin"),
    cursorAgentPath: NodePath.join(fixture, "provider", "synthetic-cursor-agent"),
    providerRequestLog: NodePath.join(fixture, "provider-requests.ndjson"),
    blockedCliLog: NodePath.join(fixture, "blocked-provider-cli.log"),
    workspace: NodePath.join(home, "workspace", "synthetic-grant-reports"),
    controlFile: NodePath.join(fixture, "control.json"),
    codexHome: NodePath.join(home, "codex"),
  };
};

const within = (child: string, parent: string) => {
  const relative = NodePath.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

/**
 * Returns why `home` may not be used, or null. Accepts only an absolute path that is missing, an
 * empty directory, or a home this fixture created, outside every real state and source location.
 */
export function fixtureHomeProblem(
  home: string,
  options: { readonly userHome?: string; readonly sourceRoot: string },
): string | null {
  if (!NodePath.isAbsolute(home)) return "--home-dir must be an absolute path.";
  const resolved = NodePath.resolve(home);
  const userHome = NodePath.resolve(options.userHome ?? NodeOS.homedir());
  if (within(userHome, resolved)) return "--home-dir must not contain your home directory.";
  for (const protectedDir of [
    ".t3",
    ".tritonai",
    ".codex",
    ".claude",
    ".cursor",
    ".config",
    ".ssh",
    ".aws",
    ".local",
    "Library",
  ])
    if (within(resolved, NodePath.join(userHome, protectedDir)))
      return `--home-dir must not be inside ~/${protectedDir}.`;
  if (within(resolved, NodePath.resolve(options.sourceRoot)))
    return "--home-dir must be outside the Harness source checkout.";
  let stat: NodeFS.Stats;
  try {
    stat = NodeFS.lstatSync(resolved);
  } catch {
    return null;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    return "--home-dir exists and is not a plain directory.";
  const entries = NodeFS.readdirSync(resolved);
  if (entries.length === 0 || entries.includes(FIXTURE_MARKER)) return null;
  return "--home-dir already has files this fixture did not create. Choose a new directory.";
}

/** Returns why the server or web port may not be used, or null. */
export function fixturePortProblem(server: number, web: number | null): string | null {
  for (const port of [server, ...(web === null ? [] : [web])])
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      return "Ports must be integers from 1024 to 65535.";
  if (server === web) return "--port and --web-port must differ.";
  return null;
}

const writeFile = (path: string, text: string, mode = 0o600) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(path, text, { mode });
};

/**
 * Creates (or refreshes) the fixture home: a synthetic secret-store keyring, settings that enable
 * only the deterministic Cursor ACP mock, blocking stubs for real provider CLIs, a private HOME,
 * and a small git workspace for the auto-created project. Existing app state is kept on rerun.
 */
export function prepareFixtureHome(home: string, mockAgentScript: string): FixtureLayout {
  const layout = fixtureLayout(home);
  NodeFS.mkdirSync(home, { recursive: true, mode: 0o700 });
  const marker = NodePath.join(home, FIXTURE_MARKER);
  if (!NodeFS.existsSync(marker))
    writeFile(
      marker,
      `${JSON.stringify({ kind: "synthetic-teams-content-fixture", createdAt: new Date().toISOString() })}\n`,
    );
  if (!NodeFS.existsSync(layout.keyringPath))
    writeFile(
      layout.keyringPath,
      `${JSON.stringify({ version: 1, active: NodeCrypto.randomBytes(32).toString("base64") })}\n`,
    );
  for (const name of BLOCKED_CLIS)
    writeFile(
      NodePath.join(layout.binDir, name),
      [
        "#!/bin/sh",
        `printf '%s\\n' "${name} $*" >> ${JSON.stringify(layout.blockedCliLog)}`,
        `echo "Synthetic Teams fixture: the real ${name} CLI is blocked." >&2`,
        "exit 127",
        "",
      ].join("\n"),
      0o755,
    );
  writeFakeCli({
    directory: NodePath.dirname(layout.cursorAgentPath),
    name: NodePath.basename(layout.cursorAgentPath),
    env: {
      T3_ACP_REQUEST_LOG_PATH: layout.providerRequestLog,
      T3_ACP_PROMPT_RESPONSE_TEXT: PROVIDER_REPLY,
    },
    source: [
      'if (process.argv[2] === "about") {',
      `  process.stdout.write(${JSON.stringify(
        JSON.stringify({
          cliVersion: "2026.04.09-synthetic",
          userEmail: "synthetic-provider@fixture.invalid",
          subscriptionTier: "synthetic",
        }),
      )} + "\\n");`,
      "  process.exit(0);",
      "}",
      execScriptSource({ scriptPath: mockAgentScript }),
    ].join("\n"),
  });
  writeFile(
    NodePath.join(layout.userHome, ".gitconfig"),
    "[user]\n\tname = Synthetic Fixture\n\temail = synthetic-fixture@fixture.invalid\n[init]\n\tdefaultBranch = main\n",
  );
  if (!NodeFS.existsSync(layout.settingsPath))
    writeFile(
      layout.settingsPath,
      `${JSON.stringify(
        {
          tritonAiManagedPolicy: {
            migrationVersion: 2,
            codexBinaryPath: NodePath.join(layout.binDir, "codex"),
            codexHomePath: layout.codexHome,
            newThreadDefaultsVersion: 1,
          },
          defaultModelSelection: { instanceId: "cursor", model: "default" },
          enableProviderUpdateChecks: false,
          providers: {
            cursor: { enabled: true, binaryPath: layout.cursorAgentPath },
            claudeAgent: { enabled: false },
            grok: { enabled: false },
            opencode: { enabled: false },
            antigravity: { enabled: false },
          },
        },
        null,
        2,
      )}\n`,
    );
  if (!NodeFS.existsSync(NodePath.join(layout.workspace, ".git"))) {
    writeFile(
      NodePath.join(layout.workspace, "README.md"),
      "# synthetic-grant-reports\n\nSynthetic Teams fixture workspace. Contains no real data.\n",
      0o644,
    );
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd: layout.workspace,
        env: { PATH: "/usr/bin:/bin", HOME: layout.userHome },
        stdio: "ignore",
      });
    git("init", "--quiet");
    git("add", "README.md");
    git("commit", "--quiet", "-m", "Synthetic fixture workspace");
  }
  return layout;
}

/**
 * The server process environment: a private HOME, provider stubs first on PATH, the fixture
 * keyring, and nothing inherited that names a credential, provider, account, or other T3 state.
 */
export function fixtureServerEnvironment(
  layout: FixtureLayout,
  inherited: NodeJS.ProcessEnv,
  nodeBinDir: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (
      /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|COOKIE|SESSION|AUTH/iu.test(name) ||
      /^(AWS|AZURE|OPENAI|ANTHROPIC|CODEX|CLAUDE|CURSOR|GROK|XAI|OPENCODE|GEMINI|GOOGLE|TRITONAI|T3CODE|T3|VITE|UCSD|ACCOUNT|NPM_CONFIG|ELECTRON)_/iu.test(
        name,
      ) ||
      ["HOME", "PATH", "HOST", "PORT", "SSH_AUTH_SOCK"].includes(name)
    )
      continue;
    env[name] = value;
  }
  return {
    ...env,
    HOME: layout.userHome,
    PATH: [layout.binDir, nodeBinDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    TRITONAI_SECRET_STORE_KEY_FILE: layout.keyringPath,
    T3CODE_TELEMETRY_ENABLED: "false",
  };
}
