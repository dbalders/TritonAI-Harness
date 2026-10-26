export const QUICKJS_EXECUTION_PROFILE = "tritonai.quickjs-wasm/v1";
export const QUICKJS_RUNTIME_FILES = {
  bootstrap: {
    name: "worker.cjs",
    sha256: "9ae556114c7bbe36daa139ad2b1b38a0dce9942097b69bf4330b8d2e3dacce4d",
  },
  engine: {
    name: "engine.wasm",
    sha256: "e2b41ab68c2b06bc8635ffc63c4777de3db04fd956a7faee14823f99082aa9ef",
  },
  bridge: {
    name: "guest-bridge.js",
    sha256: "9f3c2760a5f5f9c20d2d7b14a9a078d33db2439352af4830dec16ae87c5bbb9c",
  },
} as const;
