# Integration-only Codex build

This build applies the reviewed patch to the exact upstream source and verifies every changed file before and after compilation. It requires the Rust/Cargo version in `contract.json`; it does not install a toolchain, sign, publish or install the resulting executable.

After installing the Harness workspace dependencies, run `vp run build:integration-codex`. The default output is under the checkout's `.t3/native-build/codex-integration/`. `--help` lists explicit source, output, compiler and development-profile options. Existing source changes or output from another contract are preserved and refused.

The dedicated process accepts `--harness-integration-policy` with a bounded JSON document containing `protocol: "tritonai.codex-integration-only/v1"` and `tools: ["exact_dynamic_tool_name"]`. It captures that ceiling once. It constructs only those dynamic callbacks, with no native executor or hosted tools, inherited extensions, skill discovery, hooks or MCP connections. Cold native history restoration is refused. Host callbacks still need their own live session, catalog/schema checks and exact write approval; this ceiling grants no write authority.

The unsigned build receipt identifies bytes and inputs. It is not a release signature or authority to trust an arbitrary executable. Production admission must independently trust the runtime composition and bind the child, startup-policy digest, session and host callback catalog. This build command does not enable the runtime in Harness.

The upstream source is Apache-2.0 licensed. Its `LICENSE` and `NOTICE`, when present, accompany the built executable. A build receipt does not constitute a complete third-party license inventory or security advisory assessment.
