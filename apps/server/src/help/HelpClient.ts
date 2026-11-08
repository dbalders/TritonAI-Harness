import type { HelpClientContext } from "@t3tools/contracts";
import { safeHelpText } from "./HelpSafety.ts";

/** Schema decoding bounds the input; every remaining string is still an untrusted client report. */
export function sanitizeHelpClient(client: HelpClientContext): HelpClientContext {
  const entries = client.settings.entries.map((entry) => {
    const credential = /api.?key|password|credential|authorization|cookie|secret|token/i.test(
      entry.key,
    );
    return {
      key: safeHelpText(entry.key, 300),
      value: credential
        ? (entry.configured ?? entry.value.length > 0)
          ? "configured"
          : "missing"
        : safeHelpText(entry.value, 4_000),
      ...(entry.configured === undefined ? {} : { configured: entry.configured }),
    };
  });
  const totalCount = Math.max(client.settings.totalCount, entries.length);
  return {
    surface: client.surface,
    platform: safeHelpText(client.platform, 200),
    settingsStatus: client.settingsStatus,
    settings: {
      entries,
      totalCount,
      omittedCount: Math.max(client.settings.omittedCount, totalCount - entries.length),
    },
    settingsCatalog: client.settingsCatalog.map((item) => ({
      id: safeHelpText(item.id, 200),
      title: safeHelpText(item.title, 200),
      route: safeHelpText(item.route, 300),
      searchTerms: safeHelpText(item.searchTerms, 1_000),
      ...(item.scope === undefined ? {} : { scope: safeHelpText(item.scope, 100) }),
    })),
    ...(client.computerUse === undefined ? {} : { computerUse: { ...client.computerUse } }),
  };
}
