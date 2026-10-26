export const QUICKJS_EXECUTION_PROFILE = "tritonai.quickjs-wasm/v1";
export const QUICKJS_LAUNCHER_NODE_VERSION = "24.22.1";
export const QUICKJS_RUNTIME_FILES = {
  bootstrap: {
    name: "worker.cjs",
    sha256: "dee502688566b76fd5ae082d6de004330bb9da2f1ca6710627329d87ce235bd9",
  },
  engine: {
    name: "engine.wasm",
    sha256: "382dc56e633017da3f8b76d61efc3ec0d5673cffd6fd2ce06789cef6e37b5fb2",
  },
  bridge: {
    name: "guest-bridge.js",
    sha256: "9f3c2760a5f5f9c20d2d7b14a9a078d33db2439352af4830dec16ae87c5bbb9c",
  },
} as const;
