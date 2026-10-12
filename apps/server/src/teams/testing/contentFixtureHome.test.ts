// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - exercises the synchronous launcher setup directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  FIXTURE_MARKER,
  fixtureHomeProblem,
  fixturePortProblem,
  fixtureServerEnvironment,
  prepareFixtureHome,
} from "./contentFixtureHome.ts";

const userHome = "/Users/synthetic-person";
const sourceRoot = "/work/TritonAI-Harness";
const temp: string[] = [];
const tempDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "teams-fixture-home-"));
  temp.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temp.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("Teams content fixture home", () => {
  it("refuses real state, source, and unrelated directories", () => {
    const problem = (home: string) => fixtureHomeProblem(home, { userHome, sourceRoot });
    expect(problem("relative/home")).toContain("absolute");
    expect(problem(userHome)).toContain("home directory");
    expect(problem("/Users")).toContain("home directory");
    for (const dir of [
      ".t3/userdata",
      ".codex",
      ".claude/x",
      ".cursor",
      "Library/Application Support",
    ])
      expect(problem(`${userHome}/${dir}`)).toContain("must not be inside");
    expect(problem(`${sourceRoot}/.t3`)).toContain("source checkout");
    expect(problem(`${userHome}/Documents/new-fixture-home`)).toBeNull();

    const used = tempDir();
    NodeFS.writeFileSync(NodePath.join(used, "state.sqlite"), "");
    expect(problem(used)).toContain("did not create");
    const created = tempDir();
    NodeFS.writeFileSync(NodePath.join(created, FIXTURE_MARKER), "{}");
    NodeFS.writeFileSync(NodePath.join(created, "other"), "");
    expect(problem(created)).toBeNull();
    expect(problem(tempDir())).toBeNull();
  });

  it("requires two distinct unprivileged ports", () => {
    expect(fixturePortProblem(14_001, 14_002)).toBeNull();
    expect(fixturePortProblem(14_001, null)).toBeNull();
    expect(fixturePortProblem(80, 14_002)).toContain("1024");
    expect(fixturePortProblem(14_001, 14_001)).toContain("differ");
  });

  it("enables only the synthetic agent and blocks real provider CLIs", () => {
    const layout = prepareFixtureHome(NodePath.join(tempDir(), "home"), "/synthetic/mock.ts");
    const settings = JSON.parse(NodeFS.readFileSync(layout.settingsPath, "utf8"));
    expect(settings.providers.cursor).toEqual({
      enabled: true,
      binaryPath: layout.cursorAgentPath,
    });
    expect(settings.tritonAiManagedPolicy.codexBinaryPath).toBe(
      NodePath.join(layout.binDir, "codex"),
    );
    expect(settings.defaultModelSelection).toEqual({ instanceId: "cursor", model: "default" });
    for (const cli of ["codex", "claude", "cursor-agent", "agent"])
      expect(NodeFS.statSync(NodePath.join(layout.binDir, cli)).mode & 0o111).not.toBe(0);
    expect(NodeFS.statSync(layout.keyringPath).mode & 0o077).toBe(0);
    expect(NodeFS.existsSync(NodePath.join(layout.workspace, ".git"))).toBe(true);
    // A rerun keeps the keyring the stored secrets are sealed with.
    const keyring = NodeFS.readFileSync(layout.keyringPath, "utf8");
    prepareFixtureHome(layout.home, "/synthetic/mock.ts");
    expect(NodeFS.readFileSync(layout.keyringPath, "utf8")).toBe(keyring);
    expect(fixtureHomeProblem(layout.home, { sourceRoot })).toBeNull();
  });

  it("gives the server a private environment without inherited credentials", () => {
    const layout = prepareFixtureHome(NodePath.join(tempDir(), "home"), "/synthetic/mock.ts");
    const env = fixtureServerEnvironment(
      layout,
      {
        HOME: userHome,
        PATH: "/opt/homebrew/bin:/usr/bin",
        LANG: "en_US.UTF-8",
        OPENAI_API_KEY: "synthetic",
        T3CODE_DEV_AUTH_TOKEN: "synthetic",
        T3CODE_HOME: `${userHome}/.t3`,
        TRITONAI_HOME: `${userHome}/.t3`,
        AWS_PROFILE: "synthetic",
        GITHUB_TOKEN: "synthetic",
        T3_SERVICE_LAUNCHER_CONTEXT: "synthetic",
      },
      "/synthetic/node/bin",
    );
    expect(env).toEqual({
      LANG: "en_US.UTF-8",
      HOME: layout.userHome,
      PATH: `${layout.binDir}:/synthetic/node/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      TRITONAI_SECRET_STORE_KEY_FILE: layout.keyringPath,
      T3CODE_TELEMETRY_ENABLED: "false",
    });
  });
});
