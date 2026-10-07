/** Native returns require both a random callback path and a one-use completion proof. */
export function accountCallbackId(value: string): string | null {
  try {
    const url = new URL(value);
    const id = url.pathname.match(/^\/account\/callback\/([A-Za-z0-9_-]{43})$/u)?.[1];
    const desktop =
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      Number(url.port) >= 1024 &&
      Number(url.port) <= 65535;
    const mobile =
      ["t3code:", "t3code-dev:", "t3code-preview:"].includes(url.protocol) &&
      value.startsWith(`${url.protocol}///`) &&
      !url.host;
    return (desktop || mobile) && !url.username && !url.password && !url.search && !url.hash && id
      ? id
      : null;
  } catch {
    return null;
  }
}
