import { describe, expect, it } from "vite-plus/test";
import { accountCallbackId } from "./accountCallback.ts";
const id = "a".repeat(43);
describe("native account callback destinations", () => {
  it("accepts an ephemeral IPv4 loopback receiver", () => {
    expect(accountCallbackId(`http://127.0.0.1:45123/account/callback/${id}`)).toBe(id);
  });
  it.each(["t3code", "t3code-dev", "t3code-preview"])(
    "accepts the registered mobile scheme %s",
    (scheme) => {
      expect(accountCallbackId(`${scheme}:///account/callback/${id}`)).toBe(id);
    },
  );
  it.each([
    `evil:///account/callback/${id}`,
    `t3code-dev://evil/account/callback/${id}`,
    `t3code-dev:/account/callback/${id}`,
    `t3code-dev:///account/callback/${id}?extra=1`,
    `t3code-dev:///account/callback/${id}#fragment`,
    `https://evil.example:45123/account/callback/${id}`,
    `http://localhost:45123/account/callback/${id}`,
    `http://127.0.0.1:80/account/callback/${id}`,
    `http://127.0.0.1:45123/redirect?url=https://evil.example`,
    `http://127.0.0.1:45123/account/callback/${id}?extra=1`,
    `http://127.0.0.1:45123/account/callback/${id}#fragment`,
    `http://user@127.0.0.1:45123/account/callback/${id}`,
    `http://127.0.0.1:45123/account/callback/guess`,
  ])("rejects untrusted destinations: %s", (url) => expect(accountCallbackId(url)).toBeNull());
});
