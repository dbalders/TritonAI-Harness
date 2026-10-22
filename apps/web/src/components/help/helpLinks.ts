import {
  SETTINGS_SEARCH_ITEMS,
  SETTINGS_SECTION_LABELS,
  type SettingsPath,
  type SettingsSearchItem,
} from "../settings/settingsSearchCatalog";

export const HELP_SETTINGS_LINKS = [
  { label: "Providers", to: "/settings/providers" },
  { label: "Plugins", to: "/settings/plugins" },
  { label: "Connections", to: "/settings/connections" },
  { label: "Diagnostics", to: "/settings/diagnostics" },
] as const;

const SEARCH_ITEMS: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS;
const SETTINGS_DESTINATIONS = new Set(Object.keys(SETTINGS_SECTION_LABELS) as SettingsPath[]);

export const HELP_ISSUE_TRACKER_URL = "https://github.com/dbalders/TritonAI-Harness/issues/new";

/** Model text cannot turn arbitrary destinations, query payloads, or host files into links. */
export function resolveHelpLink(href: string | undefined) {
  if (!href) return null;
  const [pathname, hash, extra] = href.split("#");
  const internal = [...SETTINGS_DESTINATIONS].find((destination) => destination === pathname);
  if (internal && extra === undefined) {
    if (hash === undefined) return { kind: "internal", to: internal, hash: "" } as const;
    const target = SEARCH_ITEMS.find(
      (item) => item.to === internal && (item.targetId ?? item.id) === hash,
    );
    if (target) return { kind: "internal", to: internal, hash } as const;
  }
  if (href === HELP_ISSUE_TRACKER_URL) return { kind: "external", href } as const;
  return null;
}
