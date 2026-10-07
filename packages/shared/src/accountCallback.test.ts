import { describe, expect, it } from "vite-plus/test";
import { accountCallbackId } from "./accountCallback.ts";
const id = "a".repeat(43);
describe("desktop account callback destinations", () => {
  it("accepts an ephemeral IPv4 loopback receiver", () => {
    expect(accountCallbackId(`http://127.0.0.1:45123/account/callback/${id}`)).toBe(id);
  });
  it.each([
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
