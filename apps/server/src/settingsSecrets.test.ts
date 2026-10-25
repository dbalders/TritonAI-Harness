import { secretSetting } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { knownProviderSettingsFields, settingsFieldForSupport } from "./settingsSecrets.ts";
import { knownSourceControlHostSettingsFields } from "./sourceControl/sourceControlHostSecrets.ts";

describe("support settings schema projection", () => {
  it("strips undeclared children in nested arrays, union branches and record values", () => {
    const schema = Schema.Array(
      Schema.Union([
        Schema.String,
        Schema.Struct({
          slug: Schema.String,
          choices: Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.Boolean })),
        }),
      ]),
    );
    expect(
      settingsFieldForSupport(schema, [
        "legacy-slug",
        {
          slug: "model",
          proxy: { auth: ["private"] },
          choices: { main: { enabled: false, data: ["private"] } },
        },
      ]),
    ).toEqual(
      Option.some(["legacy-slug", { slug: "model", choices: { main: { enabled: false } } }]),
    );
  });

  it("fails closed for opaque schema nodes even inside a recognized field", () => {
    for (const opaque of [
      Schema.Unknown,
      Schema.Any,
      Schema.ObjectKeyword,
      Schema.Struct({}),
      Schema.Date,
    ]) {
      expect(settingsFieldForSupport(opaque, { data: ["private"] })).toEqual(Option.none());
      expect(
        settingsFieldForSupport(
          Schema.Array(Schema.Struct({ slug: Schema.String, config: opaque })),
          [{ slug: "model", config: { data: ["private"] } }],
        ),
      ).toEqual(Option.none());
    }
    expect(
      settingsFieldForSupport(Schema.Record(Schema.String, Schema.Unknown), { main: "private" }),
    ).toEqual(Option.none());
    expect(
      settingsFieldForSupport(Schema.Union([Schema.String, Schema.Unknown]), { data: "private" }),
    ).toEqual(Option.none());
    expect(settingsFieldForSupport(Schema.RedactedFromValue(Schema.String), "private")).toEqual(
      Option.none(),
    );
  });

  it("omits nested schema secrets that have no top-level presence mapping", () => {
    expect(
      settingsFieldForSupport(Schema.Struct({ ordinary: Schema.String.pipe(secretSetting) }), {
        ordinary: "private",
      }),
    ).toEqual(Option.none());
  });

  it("rejects objects under scalar fields and incompatible discriminated union branches", () => {
    expect(settingsFieldForSupport(Schema.String, { data: ["private"] })).toEqual(Option.none());
    expect(
      settingsFieldForSupport(
        Schema.Union([
          Schema.Struct({ type: Schema.Literal("select"), options: Schema.Array(Schema.String) }),
          Schema.Struct({ type: Schema.Literal("boolean"), current: Schema.Boolean }),
        ]),
        { type: "boolean", current: { data: "private" }, options: ["private"] },
      ),
    ).toEqual(Option.none());
  });

  it("uses registered provider and host schemas without defaults or normalization", () => {
    const codex = knownProviderSettingsFields("codex")!;
    const github = knownSourceControlHostSettingsFields("github")!;
    expect(settingsFieldForSupport(codex.binaryPath!, "")).toEqual(Option.some(""));
    expect(
      settingsFieldForSupport(github.hosts!, { "github.com": { enabled: false, data: "private" } }),
    ).toEqual(Option.some({ "github.com": { enabled: false } }));
    expect(knownProviderSettingsFields("future-driver")).toBeUndefined();
    expect(knownSourceControlHostSettingsFields("future-host")).toBeUndefined();
  });
});
