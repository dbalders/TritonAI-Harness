# Quick start

```bash
# Development (with hot reload)
bun run dev

# Desktop development
bun run dev:desktop

# Desktop development on an isolated port set
T3CODE_DEV_INSTANCE=feature-xyz bun run dev:desktop

# Production
bun run build
bun run start

# Build a shareable macOS .dmg (arm64 by default)
bun run dist:desktop:dmg
```

For an installed copy, use the
[latest TritonAI Installer release](https://github.com/dbalders/TritonAI-Installer/releases/latest).
The public `t3` npm package is the upstream T3 Code distribution and is not the UCSD-managed
TritonAI Harness install path.
