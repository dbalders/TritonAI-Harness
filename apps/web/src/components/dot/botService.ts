import { useClientSettings, useClientSettingsHydrated } from "../../hooks/useSettings";

const SESSION_PREFIX = "dot-session:";

/**
 * Normalizes a TritonAI Bot service address. Only HTTPS is accepted, except a
 * loopback address for a bot running on this machine. Credentials, queries and
 * fragments are rejected so the stored address is exactly where tokens go.
 */
export function normalizeBotServiceUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The address this build ships with, or null when the build has none. */
export const BUILD_DEFAULT_BOT_SERVICE_URL = normalizeBotServiceUrl(
  import.meta.env.VITE_DOT_BRIDGE_URL ?? "",
);

/** `null` follows the build default; an empty or invalid value turns the bot off. */
export function resolveBotServiceUrl(
  setting: string | null,
  buildDefault: string | null = BUILD_DEFAULT_BOT_SERVICE_URL,
): string | null {
  return setting === null ? buildDefault : normalizeBotServiceUrl(setting);
}

/** The configured bot service, or null while settings load or when none is configured. */
export function useBotServiceUrl(): string | null {
  const hydrated = useClientSettingsHydrated();
  const setting = useClientSettings((settings) => settings.tritonAiBotUrl);
  return hydrated ? resolveBotServiceUrl(setting) : null;
}

/** Signs out of every bot service except `keep`, so a session never outlives its address. */
export function clearBotSessions(
  storage: Pick<Storage, "length" | "key" | "removeItem">,
  keep: string | null = null,
): void {
  const stale: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(SESSION_PREFIX) && key !== `${SESSION_PREFIX}${keep}`) stale.push(key);
  }
  for (const key of stale) storage.removeItem(key);
}
