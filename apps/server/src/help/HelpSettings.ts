import type { HelpSetting, HelpSettingsSnapshot, ServerSettings } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";

import { redactServerSettingsForClient } from "../serverSettings.ts";
import { knownSourceControlHostSettingsFields } from "../sourceControl/sourceControlHostSecrets.ts";
import {
  knownProviderSettingsFields,
  mapSettingsSecrets,
  settingsFieldForSupport,
  SECRET_REDACTED,
} from "../settingsSecrets.ts";
import { helpSettingRequested, safeHelpText } from "./HelpSafety.ts";

const configuredSecret = "[secret configured]";
const missingSecret = "[secret missing]";
const credentialKey =
  /(?:api.?key|password|passphrase|credential|authorization|cookie|headers?|secret|(?:api|access|refresh|session|auth)[_-]?token|(?:^|[_-])token$|private.?key)/i;
const projectMap = /^project.*(?:overrides|settings)$/i;

/** Flatten schema-redacted current settings without reading any files or credential stores. */
function settingEntries(
  settings: ServerSettings,
  question: string,
): { entries: HelpSetting[]; omittedCount: number } {
  const safe = mapSettingsSecrets(redactServerSettingsForClient(settings), (secret) => ({
    value: secret.sensitive
      ? secret.redacted || secret.value.length > 0
        ? configuredSecret
        : missingSecret
      : secret.value,
    redacted: false,
  }));
  const entries: HelpSetting[] = [];
  const providerInstances = new Map(Object.entries(safe.providerInstances));
  let omittedCount = 0;
  const add = (key: string, value: string, configured?: boolean) => {
    const limit = helpSettingRequested(key, question) ? 4_000 : 600;
    const text = safeHelpText(value, 100_000);
    const suffix = ` [value truncated; ${Math.max(0, text.length - limit)}+ characters omitted]`;
    entries.push({
      key: safeHelpText(key, 300),
      value: text.length > limit ? text.slice(0, limit - suffix.length) + suffix : text,
      ...(configured === undefined ? {} : { configured }),
    });
  };
  const visitConfig = (
    value: unknown,
    key: string,
    depth: number,
    fields: Readonly<Record<string, Schema.Top>> | undefined,
    kind: "provider" | "source-control",
  ) => {
    if (!fields || typeof value !== "object" || value === null || Array.isArray(value)) {
      add(key, `[opaque ${kind} configuration omitted]`);
      omittedCount += 1;
      return;
    }
    let unknown = 0;
    for (const [name, child] of Object.entries(value)) {
      if (!Object.hasOwn(fields, name)) {
        unknown += 1;
        continue;
      }
      // Settings retain opaque driver data. Decode each present field recursively to
      // remove undeclared children, without applying defaults or normalizing saved values.
      const decoded = settingsFieldForSupport(fields[name]!, child);
      if (Option.isSome(decoded)) visit(decoded.value, `${key}.${name}`, depth + 1, name);
      else {
        add(`${key}.${name}`, "[unrecognized setting value omitted]");
        omittedCount += 1;
      }
    }
    if (unknown) {
      add(`${key}.$omitted`, `[${unknown} undeclared ${kind} fields omitted]`);
      omittedCount += unknown;
    }
  };
  const visit = (value: unknown, key: string, depth: number, field: string): void => {
    if (value === undefined) return;
    if (value === configuredSecret || value === missingSecret || value === SECRET_REDACTED) {
      add(key, value === missingSecret ? "missing" : "configured", value !== missingSecret);
      return;
    }
    if (credentialKey.test(field)) {
      const configured =
        value !== null &&
        value !== "" &&
        (typeof value !== "object" || Object.keys(value).length > 0);
      add(key, configured ? "configured" : "missing", configured);
      return;
    }
    if (depth === 2 && field === "config" && key.startsWith("providerInstances.")) {
      const instance = providerInstances.get(
        key.slice("providerInstances.".length, -".config".length),
      );
      visitConfig(
        value,
        key,
        depth,
        instance ? knownProviderSettingsFields(instance.driver) : undefined,
        "provider",
      );
      return;
    }
    if (depth === 1 && key.startsWith("sourceControlHosts.")) {
      visitConfig(value, key, depth, knownSourceControlHostSettingsFields(field), "source-control");
      return;
    }
    // Help is environment-scoped. Project ids, scripts and prompts must not spill across projects.
    if (depth === 0 && projectMap.test(field) && typeof value === "object" && value !== null) {
      omittedCount += Object.keys(value).length;
      add(
        key,
        `[${Object.keys(value).length} project override records; values and project identities omitted]`,
      );
      return;
    }
    if (/project(?:root|path)|workingdirectory|^cwd$/i.test(field)) {
      add(key, "[workspace value omitted]");
      return;
    }
    if (/scripts?|commands?|launchargs|arguments/i.test(field) && value !== null && value !== "") {
      add(
        key,
        `[configured executable content omitted${Array.isArray(value) ? `; ${value.length} records` : ""}]`,
      );
      return;
    }
    if (
      /prompt|instructions|writingstyle/i.test(field) &&
      typeof value === "string" &&
      value !== "" &&
      !helpSettingRequested(field, question)
    ) {
      add(
        key,
        `[configured text; ${value.length} characters omitted; ask for this setting to inspect it]`,
      );
      return;
    }
    if (Duration.isDuration(value)) {
      add(key, `${Duration.toMillis(value)} ms`);
      return;
    }
    if (value === null || typeof value !== "object") {
      add(key, typeof value === "string" ? value : String(value));
      return;
    }
    const children = Object.entries(value);
    if (children.length === 0) {
      add(key, Array.isArray(value) ? "[]" : "{}");
      return;
    }
    if (depth >= 10) {
      omittedCount += children.length;
      add(key, `[${children.length} nested values omitted; depth limit]`);
      return;
    }
    // Keep traversal bounded even for opaque driver config or very large user maps. Select
    // requested child keys first so a late requested model/alias is still inspectable.
    children.sort(
      ([a], [b]) =>
        Number(helpSettingRequested(b, question)) - Number(helpSettingRequested(a, question)),
    );
    for (const [index, [name, child]] of children.entries()) {
      if (index >= 1_000 || entries.length >= 10_000) {
        omittedCount += children.length - index;
        add(
          `${key}.[omitted]`,
          `[${children.length - index} remaining records omitted; extraction limit]`,
        );
        break;
      }
      // A provider may mark an env var non-sensitive even when its name says otherwise.
      if (
        name === "value" &&
        "name" in value &&
        typeof value.name === "string" &&
        credentialKey.test(value.name)
      ) {
        const configured = child !== "" && child !== missingSecret && child !== null;
        add(`${key}.value`, configured ? "configured" : "missing", configured);
      } else {
        visit(child, Array.isArray(value) ? `${key}[${name}]` : `${key}.${name}`, depth + 1, name);
      }
    }
  };
  for (const [key, value] of Object.entries(safe)) visit(value, key, 0, key);
  return { entries, omittedCount };
}

export function helpSettingsSnapshot(
  effective: ServerSettings,
  configured: ServerSettings | undefined,
  question = "",
): HelpSettingsSnapshot {
  const extracted = settingEntries(effective, question);
  const entries = extracted.entries;
  entries.unshift({
    key: "$scope",
    value:
      "Current effective environment-host settings; project overrides are summarized. configured.* entries show saved user choices that differ from effective policy.",
  });
  if (configured) {
    const effectiveByKey = new Map(entries.map((entry) => [entry.key, entry.value]));
    for (const entry of settingEntries(configured, question).entries) {
      if (effectiveByKey.get(entry.key) !== entry.value)
        entries.push({ ...entry, key: safeHelpText(`configured.${entry.key}`, 300) });
    }
  } else {
    entries.push({
      key: "$configuredStatus",
      value: "Saved user settings unavailable; effective policy comparison unavailable.",
    });
  }
  entries.sort(
    (a, b) =>
      Number(helpSettingRequested(b.key, question)) - Number(helpSettingRequested(a.key, question)),
  );
  const selected = entries.slice(0, 300);
  const totalCount = entries.length + extracted.omittedCount;
  return { entries: selected, totalCount, omittedCount: totalCount - selected.length };
}
