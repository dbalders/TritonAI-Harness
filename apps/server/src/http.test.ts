import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import { contentDispositionAttachment, isLoopbackHostname, resolveDevRedirectUrl } from "./http.ts";

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("attachment responses", () => {
  it("preserves Unicode filenames without allowing header injection", () => {
    expect(contentDispositionAttachment('résumé\r\n".pdf')).toBe(
      "attachment; filename=\"r_sum____.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9%0D%0A%22.pdf",
    );
  });

  it("replaces unpaired surrogates before URI encoding", () => {
    expect(contentDispositionAttachment(`report-${"\uD83D"}.pdf`)).toContain(
      "filename*=UTF-8''report-%EF%BF%BD.pdf",
    );
  });
});
