import {
  ClientSettingsSchema,
  isSecretSetting,
  type DesktopComputerUseState,
  type HelpClientContext,
  type HelpSetting,
  type HelpSettingsSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import { ensureClientSettingsHydrated, getClientSettings } from "../../hooks/useSettings";
import {
  SETTINGS_SEARCH_ITEMS,
  SETTINGS_SECTION_LABELS,
  type SettingsSearchItem,
} from "../settings/settingsSearchCatalog";

const PRIVATE_SETTING =
  /secret|password|credential|token|api.?key|authorization|cookie|headers?|path|profile|prompt|instruction|command|script|url|endpoint|directory|folder|home/iu;

function safeValue(ast: SchemaAST.AST, value: unknown, depth = 0): unknown {
  if (depth > 5 || isSecretSetting(Schema.make(ast))) return undefined;
  const type = SchemaAST.toType(ast);
  switch (type._tag) {
    case "String": {
      const schema = Schema.make(ast);
      const annotations = Schema.resolveAnnotationsKey(schema) ?? Schema.resolveAnnotations(schema);
      return annotations?.supportValue === true &&
        typeof value === "string" &&
        /^[\p{L}\p{N}\s'",.()_-]{0,200}$/u.test(value)
        ? value
        : undefined;
    }
    case "Null":
      return value === null ? null : undefined;
    case "Boolean":
      return typeof value === "boolean" ? value : undefined;
    case "Number":
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    case "Literal":
      return value === type.literal &&
        (typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value)) ||
          (typeof value === "string" && /^[\w .()+,:-]{0,200}$/u.test(value)))
        ? value
        : undefined;
    case "Union":
      for (const member of type.types) {
        const safe = safeValue(member, value, depth + 1);
        if (safe !== undefined) return safe;
      }
      return undefined;
    case "Objects": {
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        type.indexSignatures.length > 0 ||
        type.propertySignatures.length > 40 ||
        Object.keys(value).length !== type.propertySignatures.length
      )
        return undefined;
      const result: Record<string, unknown> = {};
      for (const property of type.propertySignatures) {
        if (typeof property.name !== "string" || PRIVATE_SETTING.test(property.name))
          return undefined;
        const safe = safeValue(property.type, Reflect.get(value, property.name), depth + 1);
        if (safe === undefined) return undefined;
        result[property.name] = safe;
      }
      return result;
    }
    default:
      // Free text, dynamic record keys, profiles and arrays can carry private payloads.
      return undefined;
  }
}

/** Support-safe values remain untrusted client reports. Free-form values are configured/omitted. */
export function helpSettingsSnapshot(
  settings: Readonly<Record<string, unknown>>,
  schema: { readonly fields: Readonly<Record<string, Schema.Top>> } = ClientSettingsSchema,
): HelpSettingsSnapshot {
  const fields = Object.entries(schema.fields);
  const extraCount = Object.keys(settings).filter(
    (key) => !Object.hasOwn(schema.fields, key),
  ).length;
  const entries: HelpSetting[] = [];
  let omittedCount = extraCount;
  for (const [key, field] of fields) {
    if (entries.length >= 300 || key.length > 300) {
      omittedCount += 1;
      continue;
    }
    const value = settings[key];
    const configured =
      value !== undefined &&
      value !== null &&
      value !== "" &&
      (Array.isArray(value)
        ? value.length > 0
        : typeof value !== "object" || Object.keys(value).length > 0);
    const candidate =
      !PRIVATE_SETTING.test(key) && !isSecretSetting(field)
        ? safeValue(field.ast, value)
        : undefined;
    // Do not walk arbitrary arrays/records just to validate a value we will omit.
    const safe = candidate !== undefined && Schema.is(field)(value) ? candidate : undefined;
    const serialized = safe === undefined ? undefined : JSON.stringify(safe);
    if (serialized === undefined || serialized.length > 4_000) {
      omittedCount += 1;
      entries.push({
        key,
        value: configured ? "Configured (value omitted)" : "Not configured",
        configured,
      });
    } else entries.push({ key, value: typeof safe === "string" ? safe : serialized });
  }
  return { entries, totalCount: fields.length + extraCount, omittedCount };
}

function clientPlatform(bridge: Window["desktopBridge"]): string {
  let platform: string;
  try {
    platform = bridge?.getClientPlatform?.() ?? globalThis.navigator?.platform ?? "";
  } catch {
    platform = globalThis.navigator?.platform ?? "";
  }
  if (/iphone|ipad|ipod/iu.test(platform)) return "ios";
  if (/android/iu.test(platform)) return "android";
  if (/darwin|mac/iu.test(platform)) return "darwin";
  if (/win/iu.test(platform)) return "win32";
  if (/linux/iu.test(platform)) return "linux";
  return "unknown";
}

// An unresponsive local bridge must not prevent the environment's Help request.
function readSupportState<A>(read: () => Promise<A>): Promise<A> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Local support state unavailable")), 2_000);
    try {
      void read().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

/** Read only on an actual send. Every awaited local read can lose its originating request. */
export async function captureHelpClientContext(
  isCurrent: () => boolean,
): Promise<HelpClientContext | null> {
  if (!isCurrent()) return null;
  let settingsStatus: HelpClientContext["settingsStatus"] = "unavailable";
  let settings: HelpSettingsSnapshot = { entries: [], totalCount: 0, omittedCount: 0 };
  try {
    await readSupportState(ensureClientSettingsHydrated);
    if (!isCurrent()) return null;
    settingsStatus = "ready";
  } catch {
    // Never present pre-hydration defaults as the user's saved preferences.
  }
  if (!isCurrent()) return null;
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  let computerUse: DesktopComputerUseState | undefined;
  if (bridge?.getComputerUseState) {
    try {
      const state = await readSupportState(() => bridge.getComputerUseState());
      if (!isCurrent()) return null;
      if (
        typeof state.enabled === "boolean" &&
        typeof state.available === "boolean" &&
        typeof state.running === "boolean" &&
        (state.accessibilityPermission === null ||
          typeof state.accessibilityPermission === "boolean") &&
        (state.screenRecordingPermission === null ||
          typeof state.screenRecordingPermission === "boolean")
      ) {
        computerUse = {
          enabled: state.enabled,
          available: state.available,
          running: state.running,
          accessibilityPermission: state.accessibilityPermission,
          screenRecordingPermission: state.screenRecordingPermission,
        };
      }
    } catch {
      // An unavailable read says nothing about permissions on the environment host.
    }
  }
  if (!isCurrent()) return null;
  if (settingsStatus === "ready") {
    try {
      settings = helpSettingsSnapshot(getClientSettings());
    } catch {
      settingsStatus = "unavailable";
    }
  }
  return {
    surface: bridge ? "desktop" : "web",
    platform: clientPlatform(bridge),
    settingsStatus,
    settings,
    settingsCatalog: [
      ...Object.entries(SETTINGS_SECTION_LABELS).map(([route, title]) => ({
        id: `settings-section:${route}`,
        title,
        route,
        searchTerms: title,
      })),
      ...(SETTINGS_SEARCH_ITEMS as readonly SettingsSearchItem[]).map((item) => ({
        id: item.id.slice(0, 200),
        title: item.title.slice(0, 200),
        route: `${item.to}#${item.targetId ?? item.id}`.slice(0, 300),
        searchTerms: (item.searchTerms ?? []).join(" ").slice(0, 1_000),
        ...(item.scope ? { scope: item.scope } : {}),
      })),
    ].slice(0, 400),
    ...(computerUse ? { computerUse } : {}),
  };
}
