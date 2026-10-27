import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const metadata = JSON.parse(
  await NodeFSP.readFile(new URL("./source.json", import.meta.url), "utf8"),
);
const [archive, compiler] = process.argv.slice(2);
if (!archive || !compiler || !NodePath.isAbsolute(archive) || !NodePath.isAbsolute(compiler))
  throw new Error("Supply the pinned QuickJS archive and absolute Emscripten compiler paths.");
const sha256 = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
if (sha256(await NodeFSP.readFile(archive)) !== metadata.engine.archiveSha256)
  throw new Error("QuickJS archive does not match its source pin.");
const { stdout: compilerVersion } = await execute(compiler, ["--version"]);
if (!compilerVersion.split("\n")[0].includes(` ${metadata.compiler.version} `))
  throw new Error("The pinned Emscripten version is required.");
const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-quickjs-build-"));
try {
  await execute("/usr/bin/tar", ["-xf", archive, "-C", temporary]);
  const source = NodePath.join(temporary, `quickjs-${metadata.engine.version}`);
  if (
    (await NodeFSP.readFile(NodePath.join(source, "VERSION"), "utf8")).trim() !==
    metadata.engine.version
  )
    throw new Error("QuickJS source version does not match its archive.");
  const directory = import.meta.dirname;
  const exports = [
    "harness_initialize",
    "harness_input",
    "harness_output",
    "harness_output_length",
    "harness_interrupts",
    "harness_evaluate",
    "harness_jobs",
    "harness_bridge_initialize",
    "harness_module_load",
    "harness_module_status",
    "harness_bridge_call",
    "harness_bridge_dispose",
  ].map((name) => `_${name}`);
  const output = NodePath.join(temporary, "engine.wasm");
  await execute(
    compiler,
    [
      "-O2",
      "-fno-exceptions",
      "-D_GNU_SOURCE",
      `-DCONFIG_VERSION="${metadata.engine.version}"`,
      `-I${source}`,
      `-ffile-prefix-map=${source}=quickjs`,
      `-ffile-prefix-map=${directory}=tritonai-plugin-runtime`,
      NodePath.join(directory, "interpreter.c"),
      ...["quickjs.c", "dtoa.c", "libregexp.c", "libunicode.c", "cutils.c"].map((name) =>
        NodePath.join(source, name),
      ),
      "-sSTANDALONE_WASM=1",
      "--no-entry",
      "-sFILESYSTEM=0",
      "-sALLOW_MEMORY_GROWTH=0",
      `-sINITIAL_MEMORY=${metadata.limits.linearMemoryBytes}`,
      `-sMAXIMUM_MEMORY=${metadata.limits.linearMemoryBytes}`,
      `-sSTACK_SIZE=${metadata.limits.cStackBytes}`,
      "-sALLOW_TABLE_GROWTH=0",
      "-sMALLOC=emmalloc",
      "-sASSERTIONS=0",
      `-sSTACK_OVERFLOW_CHECK=${metadata.limits.stackOverflowCheck}`,
      "-Wl,--stack-first",
      "-sERROR_ON_UNDEFINED_SYMBOLS=1",
      `-sEXPORTED_FUNCTIONS=${JSON.stringify(exports)}`,
      "-o",
      output,
    ],
    { maxBuffer: 1_048_576 },
  );
  const bytes = await NodeFSP.readFile(output);
  await NodeFSP.writeFile(NodePath.join(directory, "engine.wasm"), bytes);
  process.stdout.write(
    JSON.stringify({
      executionProfile: metadata.executionProfile,
      sha256: sha256(bytes),
      bytes: bytes.length,
    }) + "\n",
  );
} finally {
  await NodeFSP.rm(temporary, { recursive: true, force: true });
}
