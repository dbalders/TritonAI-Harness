import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

it.layer(NodeServices.layer)("README installation guidance", (it) => {
  it.effect("points readers to the public TritonAI-Installer release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const readme = yield* fs.readFileString(path.join(repoRoot, "README.md"));
      const installationSection = readme.match(/^## Installation\n([\s\S]*?)(?=^## )/m)?.[1] ?? "";

      assert.include(
        installationSection,
        "[latest TritonAI-Installer release](https://github.com/dbalders/TritonAI-Installer/releases/latest)",
      );
      assert.notInclude(installationSection, "Desktop_Installer");
      assert.notInclude(installationSection, "release may be private");
    }),
  );
});
