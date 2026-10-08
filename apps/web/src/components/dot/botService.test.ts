import { describe, expect, it } from "vite-plus/test";

import { clearBotSessions, normalizeBotServiceUrl, resolveBotServiceUrl } from "./botService";
import { readDotSession, saveDotSession } from "./dotClient";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
  };
}

describe("TritonAI Bot service address", () => {
  it("accepts HTTPS and loopback addresses and strips trailing slashes", () => {
    expect(normalizeBotServiceUrl(" https://bot.example.test/prod/ ")).toBe(
      "https://bot.example.test/prod",
    );
    expect(normalizeBotServiceUrl("https://bot.example.test")).toBe("https://bot.example.test");
    expect(normalizeBotServiceUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
  });

  it("rejects addresses that could send a token somewhere unexpected", () => {
    for (const value of [
      "",
      "not a url",
      "http://bot.example.test",
      "https://user:pass@bot.example.test",
      "https://bot.example.test/?next=https://elsewhere.test",
      "https://bot.example.test/#x",
      "javascript:alert(1)",
    ])
      expect(normalizeBotServiceUrl(value)).toBeNull();
  });

  it("follows the build default until the user replaces or clears it", () => {
    const buildDefault = "https://default.example.test";
    expect(resolveBotServiceUrl(null, buildDefault)).toBe(buildDefault);
    expect(resolveBotServiceUrl(null, null)).toBeNull();
    expect(resolveBotServiceUrl("", buildDefault)).toBeNull();
    expect(resolveBotServiceUrl("https://mine.example.test/", buildDefault)).toBe(
      "https://mine.example.test",
    );
    expect(resolveBotServiceUrl("http://mine.example.test", buildDefault)).toBeNull();
  });

  it("keeps sessions per address and signs out of every other service", () => {
    const storage = memoryStorage();
    const session = {
      ownerToken: "synthetic",
      expiresAt: Date.now() / 1000 + 600,
      email: "a@ucsd.edu",
    };
    saveDotSession(storage, "https://old.example.test", session);
    saveDotSession(storage, "https://new.example.test", session);
    storage.setItem("unrelated", "kept");
    expect(readDotSession(storage, "https://other.example.test")).toBeNull();
    clearBotSessions(storage, "https://new.example.test");
    expect(readDotSession(storage, "https://old.example.test")).toBeNull();
    expect(readDotSession(storage, "https://new.example.test")).toEqual(session);
    clearBotSessions(storage);
    expect(readDotSession(storage, "https://new.example.test")).toBeNull();
    expect(storage.getItem("unrelated")).toBe("kept");
  });
});
