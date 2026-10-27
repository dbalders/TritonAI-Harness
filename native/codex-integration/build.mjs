#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as HostProcess from "../../packages/shared/src/HostProcess.ts";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const directory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const { values } = NodeUtil.parseArgs({
  options: {
    "source-root": { type: "string" },
    output: { type: "string" },
    cargo: { type: "string", default: "cargo" },
    rustc: { type: "string", default: "rustc" },
    git: { type: "string", default: "git" },
    profile: { type: "string", default: "release" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  process.stdout.write(
    "Build the pinned integration-only Codex runtime; installs and publishes nothing.\n" +
      "node native/codex-integration/build.mjs [--source-root DIR] [--output DIR] " +
      "[--cargo EXE] [--rustc EXE] [--git EXE] [--profile release|dev]\n",
  );
  process.exit(0);
}

async function hash(file) {
  const digest = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : ["ignore", "inherit", "inherit"],
      shell: false,
    });
    let text = "";
    if (options.capture)
      child.stdout.on("data", (chunk) => {
        text += chunk.toString("utf8");
        if (Buffer.byteLength(text) > 1024 * 1024) {
          child.kill();
          reject(new Error("Build command output exceeded its bound."));
        }
      });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(text.trimEnd());
      else
        reject(
          new Error(`Build command failed (${code ?? signal}): ${NodePath.basename(command)}`),
        );
    });
  });
}

async function build() {
  if (!["darwin", "win32"].includes(HostProcess.Platform.defaultValue()))
    throw new Error("Integration runtime builds currently target native macOS or Windows hosts.");
  if (!["dev", "release"].includes(values.profile)) throw new Error("Unsupported build profile.");
  const contractBytes = await NodeFSP.readFile(NodePath.join(directory, "contract.json"));
  const contract = JSON.parse(contractBytes);
  const patch = NodePath.join(directory, "runtime.patch");
  if (contract.version !== 1 || (await hash(patch)) !== contract.patchSha256)
    throw new Error("Native runtime contract or patch identity mismatch.");
  const env = { ...process.env, RUSTUP_TOOLCHAIN: contract.upstream.rust, RUSTC: values.rustc };
  const rust = await run(values.rustc, ["--version"], { capture: true, env });
  const cargo = await run(values.cargo, ["--version"], { capture: true, env });
  if (
    !rust.startsWith(`rustc ${contract.upstream.rust} `) ||
    !cargo.startsWith(`cargo ${contract.upstream.rust} `)
  )
    throw new Error("Use the exact Rust/Cargo version named in the runtime contract.");
  const cache = NodePath.resolve(directory, "../../.t3/native-build/codex-integration");
  const source = NodePath.resolve(values["source-root"] ?? NodePath.join(cache, "source"));
  const output = NodePath.resolve(
    values.output ??
      NodePath.join(
        cache,
        `${HostProcess.Platform.defaultValue()}-${HostProcess.Architecture.defaultValue()}`,
        values.profile,
      ),
  );
  if (source === output || output.startsWith(`${source}${NodePath.sep}`))
    throw new Error("Keep build output outside the verified source checkout.");
  const git = (args, capture = true) =>
    run(values.git, ["-c", "credential.helper=", "-c", "core.autocrlf=false", ...args], {
      cwd: source,
      capture,
    });
  await NodeFSP.mkdir(source, { recursive: true });
  let entries = await NodeFSP.readdir(source);
  if (entries.length === 0) {
    await git(["init"]);
    await git([
      "fetch",
      "--depth=1",
      "--no-tags",
      contract.upstream.repository,
      contract.upstream.commit,
    ]);
    await git([
      "-c",
      `core.hooksPath=${HostProcess.Platform.defaultValue() === "win32" ? "NUL" : "/dev/null"}`,
      "checkout",
      "--detach",
      "FETCH_HEAD",
    ]);
  } else if (!entries.includes(".git")) {
    throw new Error("Existing source directory is not this build's Git checkout; preserved.");
  }
  if (
    (await NodeFSP.realpath(await git(["rev-parse", "--show-toplevel"]))) !==
      (await NodeFSP.realpath(source)) ||
    (await git(["rev-parse", "HEAD"])) !== contract.upstream.commit
  )
    throw new Error("Existing source is not the pinned upstream checkout; preserved.");
  const expected = new Set(Object.keys(contract.files));
  const verify = async () => {
    const rows = (await git(["status", "--porcelain=v1", "--untracked-files=all"]))
      .split("\n")
      .filter(Boolean);
    if (rows.some((row) => !expected.has(row.slice(3))))
      throw new Error("Source checkout contains unrelated changes; preserved.");
    for (const [file, digest] of Object.entries(contract.files)) {
      if ((await hash(NodePath.join(source, file)).catch(() => null)) !== digest) return false;
    }
    return true;
  };
  if (!(await verify())) {
    if (await git(["status", "--porcelain=v1", "--untracked-files=all"]))
      throw new Error("Source contains an incomplete or different patch; preserved.");
    if (
      (await hash(NodePath.join(source, "codex-rs/Cargo.lock"))) !==
      contract.upstreamCargoLockSha256
    )
      throw new Error("Unexpected upstream dependency lock.");
    await git(["apply", "--check", patch]);
    await git(["apply", patch]);
    if (!(await verify()))
      throw new Error("Patched source hashes do not match the reviewed input.");
  }
  await NodeFSP.mkdir(output, { recursive: true });
  entries = await NodeFSP.readdir(output);
  const marker = NodePath.join(output, "build-receipt.json");
  if (entries.length > 0 && !entries.includes("build-receipt.json"))
    throw new Error("Output directory has unrelated files; preserved.");
  if (entries.includes("build-receipt.json")) {
    const existing = JSON.parse(await NodeFSP.readFile(marker, "utf8"));
    if (
      existing.contractSha256 !==
      NodeCrypto.createHash("sha256").update(contractBytes).digest("hex")
    )
      throw new Error("Output belongs to a different runtime contract; preserved.");
  }
  const target = NodePath.join(source, "codex-rs/target");
  await run(
    values.cargo,
    [
      "build",
      "--locked",
      "-p",
      "codex-app-server",
      "--bin",
      "codex-app-server",
      "--profile",
      values.profile,
    ],
    {
      cwd: NodePath.join(source, "codex-rs"),
      env: {
        ...env,
        CARGO_TARGET_DIR: target,
        CARGO_BUILD_JOBS: "4",
        ...(values.profile === "dev" ? { CARGO_PROFILE_DEV_DEBUG: "0" } : {}),
      },
    },
  );
  if (!(await verify()))
    throw new Error("Source changed during the native build; output withheld.");
  const name = `codex-app-server${HostProcess.Platform.defaultValue() === "win32" ? ".exe" : ""}`;
  const binary = NodePath.join(target, values.profile === "dev" ? "debug" : "release", name);
  const binaryDigest = await hash(binary);
  const stage = NodePath.join(output, `.${name}.${NodeCrypto.randomUUID()}`);
  await NodeFSP.copyFile(binary, stage);
  await NodeFSP.chmod(stage, 0o755);
  if ((await hash(stage)) !== binaryDigest)
    throw new Error("Native artifact copy failed verification.");
  await NodeFSP.rename(stage, NodePath.join(output, name));
  for (const license of ["LICENSE", "NOTICE"]) {
    if ((await NodeFSP.stat(NodePath.join(source, license)).catch(() => null))?.isFile())
      await NodeFSP.copyFile(NodePath.join(source, license), NodePath.join(output, license));
  }
  const receipt = {
    version: 1,
    protocol: contract.protocol,
    upstreamSource: contract.upstream.commit,
    patchSha256: contract.patchSha256,
    contractSha256: NodeCrypto.createHash("sha256").update(contractBytes).digest("hex"),
    cargoLockSha256: await hash(NodePath.join(source, "codex-rs/Cargo.lock")),
    platform: HostProcess.Platform.defaultValue(),
    architecture: HostProcess.Architecture.defaultValue(),
    profile: values.profile,
    rust,
    cargo,
    binary: { file: name, sha256: binaryDigest, bytes: (await NodeFSP.stat(binary)).size },
    signed: false,
  };
  await NodeFSP.writeFile(marker, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, ...receipt })}\n`);
}

await build().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Native runtime build failed."}\n`,
  );
  process.exitCode = 1;
});
