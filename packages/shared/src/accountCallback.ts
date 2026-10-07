/** Only a short-lived listener on the user's own desktop may skip device confirmation. */
export function accountCallbackId(value: string): string | null {
  try {
    const url = new URL(value);
    const id = url.pathname.match(/^\/account\/callback\/([A-Za-z0-9_-]{43})$/u)?.[1];
    return url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      Number(url.port) >= 1024 &&
      Number(url.port) <= 65535 &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      id
      ? id
      : null;
  } catch {
    return null;
  }
}
