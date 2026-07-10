// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { parse } from "yaml";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

const workspaceFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "apps/mobile/package.json",
  "apps/mobile/deps/react-native-nitro-markdown-0.5.0.tgz",
  "apps/mobile/modules/t3-markdown-text/package.json",
  "apps/mobile/modules/t3-review-diff/package.json",
  "apps/mobile/modules/t3-terminal/package.json",
  "apps/marketing/package.json",
  "infra/relay/package.json",
  "oxlint-plugin-t3code/package.json",
  "packages/client-runtime/package.json",
  "packages/contracts/package.json",
  "packages/shared/package.json",
  "packages/ssh/package.json",
  "packages/tailscale/package.json",
  "packages/effect-acp/package.json",
  "packages/effect-codex-app-server/package.json",
  "scripts/package.json",
] as const;

type WorkflowStep = {
  readonly id?: string;
  readonly name?: string;
  readonly if?: string;
  readonly run?: string;
};

type WorkflowJob = {
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly outputs?: Readonly<Record<string, string>>;
  readonly steps?: readonly WorkflowStep[];
};

type Workflow = {
  readonly jobs?: Readonly<Record<string, WorkflowJob>>;
};

function copyWorkspaceManifestFixture(targetRoot: string): void {
  for (const relativePath of workspaceFiles) {
    const sourcePath = NodePath.resolve(repoRoot, relativePath);
    const destinationPath = NodePath.resolve(targetRoot, relativePath);
    NodeFS.mkdirSync(NodePath.dirname(destinationPath), { recursive: true });
    NodeFS.cpSync(sourcePath, destinationPath);
  }

  const patchesDirectory = NodePath.resolve(repoRoot, "patches");
  if (NodeFS.existsSync(patchesDirectory)) {
    NodeFS.cpSync(patchesDirectory, NodePath.resolve(targetRoot, "patches"), { recursive: true });
  }
}

function writeMacManifestFixtures(targetRoot: string): { arm64Path: string; x64Path: string } {
  const assetDirectory = NodePath.resolve(targetRoot, "release-assets");
  NodeFS.mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = NodePath.resolve(assetDirectory, "latest-mac.yml");
  const x64Path = NodePath.resolve(assetDirectory, "latest-mac-x64.yml");

  NodeFS.writeFileSync(
    arm64Path,
    `version: 9.9.9-smoke.0
files:
  - url: T3-Code-9.9.9-smoke.0-arm64.zip
    sha512: arm64zip
    size: 125621344
  - url: T3-Code-9.9.9-smoke.0-arm64.dmg
    sha512: arm64dmg
    size: 131754935
path: T3-Code-9.9.9-smoke.0-arm64.zip
sha512: arm64zip
releaseDate: '2026-03-08T10:32:14.587Z'
`,
  );

  NodeFS.writeFileSync(
    x64Path,
    `version: 9.9.9-smoke.0
files:
  - url: T3-Code-9.9.9-smoke.0-x64.zip
    sha512: x64zip
    size: 132000112
  - url: T3-Code-9.9.9-smoke.0-x64.dmg
    sha512: x64dmg
    size: 138148807
path: T3-Code-9.9.9-smoke.0-x64.zip
sha512: x64zip
releaseDate: '2026-03-08T10:36:07.540Z'
`,
  );

  return { arm64Path, x64Path };
}

function writeWindowsManifestFixtures(
  targetRoot: string,
  channel: string,
): { arm64Path: string; x64Path: string } {
  const assetDirectory = NodePath.resolve(targetRoot, "release-assets");
  NodeFS.mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = NodePath.resolve(assetDirectory, `${channel}-win-arm64.yml`);
  const x64Path = NodePath.resolve(assetDirectory, `${channel}-win-x64.yml`);

  NodeFS.writeFileSync(
    arm64Path,
    `version: 9.9.9-smoke.0
files:
  - url: T3-Code-9.9.9-smoke.0-arm64.exe
    sha512: arm64exe
    size: 126621344
  - url: T3-Code-9.9.9-smoke.0-arm64.exe.blockmap
    sha512: arm64blockmap
    size: 152344
path: T3-Code-9.9.9-smoke.0-arm64.exe
sha512: arm64exe
releaseDate: '2026-03-08T10:32:14.587Z'
`,
  );

  NodeFS.writeFileSync(
    x64Path,
    `version: 9.9.9-smoke.0
files:
  - url: T3-Code-9.9.9-smoke.0-x64.exe
    sha512: x64exe
    size: 132000112
  - url: T3-Code-9.9.9-smoke.0-x64.exe.blockmap
    sha512: x64blockmap
    size: 160112
path: T3-Code-9.9.9-smoke.0-x64.exe
sha512: x64exe
releaseDate: '2026-03-08T10:36:07.540Z'
`,
  );

  return { arm64Path, x64Path };
}

function writeWindowsBuilderDebugFixtures(targetRoot: string): {
  arm64Path: string;
  x64Path: string;
} {
  const assetDirectory = NodePath.resolve(targetRoot, "release-assets");
  NodeFS.mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = NodePath.resolve(assetDirectory, "builder-debug-win-arm64.yml");
  const x64Path = NodePath.resolve(assetDirectory, "builder-debug-win-x64.yml");
  const debugFixture = `arm64:
  firstOrDefaultFilePatterns:
    - '**/*'
nsis:
  script: |-
    !include "example.nsh"
`;

  NodeFS.writeFileSync(arm64Path, debugFixture);
  NodeFS.writeFileSync(x64Path, debugFixture);

  return { arm64Path, x64Path };
}
function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(message);
  }
}

function assertExists(path: string, message: string): void {
  if (!NodeFS.existsSync(path)) {
    throw new Error(message);
  }
}

function assertPackageVersion(path: string, version: string): void {
  const packageJson = JSON.parse(NodeFS.readFileSync(path, "utf8")) as {
    readonly version?: unknown;
  };

  if (packageJson.version !== version) {
    throw new Error(`Expected ${path} to have version ${version}.`);
  }
}

function assertMissing(path: string, message: string): void {
  if (NodeFS.existsSync(path)) {
    throw new Error(message);
  }
}

function getWorkflowJob(workflow: Workflow, jobId: string): WorkflowJob {
  const job = workflow.jobs?.[jobId];
  if (job === undefined) {
    throw new Error(`Expected workflow job ${jobId}.`);
  }
  return job;
}

function getWorkflowStep(job: WorkflowJob, stepId: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.id === stepId);
  if (step === undefined) {
    throw new Error(`Expected workflow step ${stepId}.`);
  }
  return step;
}

function getWorkflowStepByName(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  if (step === undefined) {
    throw new Error(`Expected workflow step named ${name}.`);
  }
  return step;
}

function runConfigurationGate(
  step: WorkflowStep,
  outputPath: string,
  environment: Readonly<Record<string, string>>,
  expected: "true" | "false",
): void {
  if (step.run === undefined) {
    throw new Error("Expected configuration gate to have a run script.");
  }

  NodeFS.writeFileSync(outputPath, "");
  NodeChildProcess.execFileSync("bash", ["-c", step.run], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...environment,
      GITHUB_OUTPUT: outputPath,
    },
    stdio: "pipe",
  });

  const output = NodeFS.readFileSync(outputPath, "utf8");
  assertContains(
    output,
    `configured=${expected}`,
    `Expected configuration gate to resolve configured=${expected}.`,
  );
}

function assertOptionalT3ConnectWorkflows(targetRoot: string): void {
  const releaseWorkflow = parse(
    NodeFS.readFileSync(NodePath.resolve(repoRoot, ".github/workflows/release.yml"), "utf8"),
  ) as Workflow;
  const relayConfigJob = getWorkflowJob(releaseWorkflow, "relay_public_config");
  const releaseConfigStep = getWorkflowStep(relayConfigJob, "relay_config");

  if (relayConfigJob.outputs?.configured !== "${{ steps.relay_config.outputs.configured }}") {
    throw new Error("Expected release workflow to expose the T3 Connect configuration state.");
  }

  const releaseEnvironment = {
    CLOUDFLARE_ACCOUNT_ID: "",
    CLOUDFLARE_API_TOKEN: "",
    RELAY_DOMAIN: "",
    RELAY_API_ZONE_NAME: "",
    CLERK_PUBLISHABLE_KEY: "",
    CLERK_JWT_TEMPLATE: "",
    CLERK_CLI_OAUTH_CLIENT_ID: "",
  };
  const releaseOutputPath = NodePath.resolve(targetRoot, "release-config-output");
  runConfigurationGate(releaseConfigStep, releaseOutputPath, releaseEnvironment, "false");
  runConfigurationGate(
    releaseConfigStep,
    releaseOutputPath,
    {
      ...releaseEnvironment,
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "token",
      RELAY_API_ZONE_NAME: "example.com",
      CLERK_PUBLISHABLE_KEY: "pk_test_example",
      CLERK_JWT_TEMPLATE: "t3code",
      CLERK_CLI_OAUTH_CLIENT_ID: "client",
    },
    "true",
  );

  for (const stepName of [
    "Checkout",
    "Setup Vite+",
    "Read production relay tracing config",
    "Upload relay client tracing config",
    "Resolve production relay public config",
  ]) {
    assertContains(
      getWorkflowStepByName(relayConfigJob, stepName).if ?? "",
      "steps.relay_config.outputs.configured == 'true'",
      `Expected release step ${stepName} to skip when T3 Connect is not configured.`,
    );
  }

  for (const jobId of ["build", "publish_cli"]) {
    const job = getWorkflowJob(releaseWorkflow, jobId);
    for (const stepName of [
      "Download relay client tracing config",
      "Load relay client tracing config",
    ]) {
      assertContains(
        getWorkflowStepByName(job, stepName).if ?? "",
        "needs.relay_public_config.outputs.configured == 'true'",
        `Expected ${jobId} to skip ${stepName} when T3 Connect is not configured.`,
      );
    }
  }

  assertContains(
    getWorkflowJob(releaseWorkflow, "deploy_web").if ?? "",
    "needs.relay_public_config.outputs.configured == 'true'",
    "Expected hosted web deployment to require T3 Connect configuration.",
  );
  assertContains(
    getWorkflowJob(releaseWorkflow, "announce_discord").if ?? "",
    "needs.relay_public_config.outputs.configured != 'true'",
    "Expected release announcements to allow an intentionally skipped hosted web deployment.",
  );

  const deployWorkflow = parse(
    NodeFS.readFileSync(NodePath.resolve(repoRoot, ".github/workflows/deploy-relay.yml"), "utf8"),
  ) as Workflow;
  const deployConfigJob = getWorkflowJob(deployWorkflow, "check_config");
  const deployConfigStep = getWorkflowStep(deployConfigJob, "relay_config");
  const deployJob = getWorkflowJob(deployWorkflow, "deploy_relay");

  if (deployConfigJob.outputs?.configured !== "${{ steps.relay_config.outputs.configured }}") {
    throw new Error("Expected relay deploy workflow to expose its configuration state.");
  }
  assertContains(
    deployJob.if ?? "",
    "needs.check_config.outputs.configured == 'true'",
    "Expected relay deployment to skip when T3 Connect is not configured.",
  );

  const deployEnvironment = {
    CLOUDFLARE_ACCOUNT_ID: "",
    CLOUDFLARE_API_TOKEN: "",
    PLANETSCALE_ORGANIZATION: "",
    PLANETSCALE_API_TOKEN_ID: "",
    PLANETSCALE_API_TOKEN: "",
    AXIOM_ORG_ID: "",
    AXIOM_TOKEN: "",
    RELAY_DOMAIN: "",
    RELAY_API_ZONE_NAME: "",
    RELAY_TUNNEL_ZONE_NAME: "",
    CLERK_PUBLISHABLE_KEY: "",
    CLERK_JWT_AUDIENCE: "",
    CLERK_SECRET_KEY: "",
    APNS_ENVIRONMENT: "",
    APNS_TEAM_ID: "",
    APNS_KEY_ID: "",
    APNS_BUNDLE_ID: "",
    APNS_PRIVATE_KEY: "",
  };
  const deployOutputPath = NodePath.resolve(targetRoot, "deploy-config-output");
  runConfigurationGate(deployConfigStep, deployOutputPath, deployEnvironment, "false");
  runConfigurationGate(
    deployConfigStep,
    deployOutputPath,
    Object.fromEntries(Object.keys(deployEnvironment).map((name) => [name, "configured"])),
    "true",
  );
}

const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-release-smoke-"));

try {
  copyWorkspaceManifestFixture(tempRoot);
  assertOptionalT3ConnectWorkflows(tempRoot);

  NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.resolve(repoRoot, "scripts/update-release-package-versions.ts"),
      "9.9.9-smoke.0",
      "--root",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  NodeFS.rmSync(NodePath.resolve(tempRoot, "pnpm-lock.yaml"), { force: true });

  NodeChildProcess.execFileSync("vp", ["install", "--lockfile-only", "--ignore-scripts"], {
    cwd: tempRoot,
    stdio: "inherit",
  });

  const lockfile = NodeFS.readFileSync(NodePath.resolve(tempRoot, "pnpm-lock.yaml"), "utf8");
  assertContains(lockfile, "lockfileVersion:", "Expected pnpm-lock.yaml to be regenerated.");

  for (const relativePath of [
    "apps/server/package.json",
    "apps/desktop/package.json",
    "apps/web/package.json",
    "packages/contracts/package.json",
  ]) {
    assertPackageVersion(NodePath.resolve(tempRoot, relativePath), "9.9.9-smoke.0");
  }

  const nightlyReleaseMetadata = NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.resolve(repoRoot, "scripts/resolve-nightly-release.ts"),
      "--date",
      "20260413",
      "--run-number",
      "321",
      "--sha",
      "abcdef1234567890",
      "--root",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  assertContains(
    nightlyReleaseMetadata,
    "version=9.9.10-nightly.20260413.321",
    "Expected nightly metadata to contain the derived nightly version.",
  );
  assertContains(
    nightlyReleaseMetadata,
    "tag=v9.9.10-nightly.20260413.321",
    "Expected nightly metadata to contain the derived nightly tag.",
  );
  assertContains(
    nightlyReleaseMetadata,
    "name=TritonAI Harness Nightly 9.9.10-nightly.20260413.321 (abcdef123456)",
    "Expected nightly metadata to include the short commit SHA in the release name.",
  );

  const { arm64Path, x64Path } = writeMacManifestFixtures(tempRoot);
  NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.resolve(repoRoot, "scripts/merge-update-manifests.ts"),
      "--platform",
      "mac",
      arm64Path,
      x64Path,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  const mergedManifest = NodeFS.readFileSync(arm64Path, "utf8");
  assertContains(
    mergedManifest,
    "T3-Code-9.9.9-smoke.0-arm64.zip",
    "Merged manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedManifest,
    "T3-Code-9.9.9-smoke.0-x64.zip",
    "Merged manifest is missing the x64 asset.",
  );

  const { arm64Path: winArm64Path, x64Path: winX64Path } = writeWindowsManifestFixtures(
    tempRoot,
    "latest",
  );
  const mergedWindowsManifestPath = NodePath.resolve(tempRoot, "release-assets/latest.yml");
  const { arm64Path: nightlyWinArm64Path, x64Path: nightlyWinX64Path } =
    writeWindowsManifestFixtures(tempRoot, "nightly");
  const mergedNightlyWindowsManifestPath = NodePath.resolve(tempRoot, "release-assets/nightly.yml");
  const { arm64Path: previewWinArm64Path, x64Path: previewWinX64Path } =
    writeWindowsManifestFixtures(tempRoot, "preview");
  const mergedPreviewWindowsManifestPath = NodePath.resolve(tempRoot, "release-assets/preview.yml");
  const { arm64Path: winDebugArm64Path, x64Path: winDebugX64Path } =
    writeWindowsBuilderDebugFixtures(tempRoot);
  NodeChildProcess.execFileSync(
    "bash",
    [
      "-lc",
      `
        release_assets_dir=${JSON.stringify(NodePath.resolve(tempRoot, "release-assets"))}
        shopt -s nullglob
        found_windows_manifest=false
        for x64_manifest in "$release_assets_dir"/*-win-x64.yml; do
          if [[ "$(basename "$x64_manifest")" == builder-debug-* ]]; then
            continue
          fi

          arm64_manifest="\${x64_manifest/-x64.yml/-arm64.yml}"
          output_manifest="\${x64_manifest/-win-x64.yml/.yml}"
          if [[ ! -f "$arm64_manifest" ]]; then
            echo "Missing matching arm64 Windows manifest for $x64_manifest" >&2
            exit 1
          fi

          found_windows_manifest=true
          ${JSON.stringify(process.execPath)} ${JSON.stringify(NodePath.resolve(repoRoot, "scripts/merge-update-manifests.ts"))} --platform win \
            "$arm64_manifest" \
            "$x64_manifest" \
            "$output_manifest"
          rm -f "$arm64_manifest" "$x64_manifest"
        done

        if [[ "$found_windows_manifest" != true ]]; then
          echo "No Windows updater manifests found to merge." >&2
          exit 1
        fi
      `,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  const mergedWindowsManifest = NodeFS.readFileSync(mergedWindowsManifestPath, "utf8");
  assertContains(
    mergedWindowsManifest,
    "T3-Code-9.9.9-smoke.0-arm64.exe",
    "Merged Windows manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedWindowsManifest,
    "T3-Code-9.9.9-smoke.0-x64.exe",
    "Merged Windows manifest is missing the x64 asset.",
  );
  const mergedNightlyWindowsManifest = NodeFS.readFileSync(
    mergedNightlyWindowsManifestPath,
    "utf8",
  );
  assertContains(
    mergedNightlyWindowsManifest,
    "T3-Code-9.9.9-smoke.0-arm64.exe",
    "Merged nightly Windows manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedNightlyWindowsManifest,
    "T3-Code-9.9.9-smoke.0-x64.exe",
    "Merged nightly Windows manifest is missing the x64 asset.",
  );
  const mergedPreviewWindowsManifest = NodeFS.readFileSync(
    mergedPreviewWindowsManifestPath,
    "utf8",
  );
  assertContains(
    mergedPreviewWindowsManifest,
    "T3-Code-9.9.9-smoke.0-arm64.exe",
    "Merged preview Windows manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedPreviewWindowsManifest,
    "T3-Code-9.9.9-smoke.0-x64.exe",
    "Merged preview Windows manifest is missing the x64 asset.",
  );
  assertMissing(
    winArm64Path,
    "Windows release smoke unexpectedly kept the arm64 updater manifest.",
  );
  assertMissing(winX64Path, "Windows release smoke unexpectedly kept the x64 updater manifest.");
  assertMissing(
    nightlyWinArm64Path,
    "Windows release smoke unexpectedly kept the nightly arm64 updater manifest.",
  );
  assertMissing(
    nightlyWinX64Path,
    "Windows release smoke unexpectedly kept the nightly x64 updater manifest.",
  );
  assertMissing(
    previewWinArm64Path,
    "Windows release smoke unexpectedly kept the preview arm64 updater manifest.",
  );
  assertMissing(
    previewWinX64Path,
    "Windows release smoke unexpectedly kept the preview x64 updater manifest.",
  );
  assertExists(
    winDebugArm64Path,
    "Windows release smoke unexpectedly removed the arm64 builder debug fixture.",
  );
  assertExists(
    winDebugX64Path,
    "Windows release smoke unexpectedly removed the x64 builder debug fixture.",
  );

  Effect.runSync(Console.log("Release smoke checks passed."));
} finally {
  NodeFS.rmSync(tempRoot, { recursive: true, force: true });
}
