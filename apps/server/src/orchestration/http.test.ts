import { PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  exceedsPendingAttachmentCapacity,
  isPendingAttachmentExpired,
  sanitizeAttachmentFileName,
} from "./http.ts";

describe("pending attachment policy", () => {
  it("expires old pending files but preserves files without trustworthy timestamps", () => {
    expect(isPendingAttachmentExpired({ modifiedAt: 0, now: 60 * 60 * 1000 + 1 })).toBe(true);
    expect(isPendingAttachmentExpired({ modifiedAt: 1, now: 60 * 60 * 1000 })).toBe(false);
    expect(isPendingAttachmentExpired({ modifiedAt: null, now: Number.MAX_SAFE_INTEGER })).toBe(
      false,
    );
  });

  it("caps pending bytes per thread and across the environment", () => {
    expect(
      exceedsPendingAttachmentCapacity({
        targetPendingBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES - 1,
        globalPendingBytes: 0,
        incomingBytes: 1,
      }),
    ).toBe(false);
    expect(
      exceedsPendingAttachmentCapacity({
        targetPendingBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
        globalPendingBytes: 0,
        incomingBytes: 1,
      }),
    ).toBe(true);
    expect(
      exceedsPendingAttachmentCapacity({
        targetPendingBytes: 0,
        globalPendingBytes: 10 * PROVIDER_SEND_TURN_MAX_FILE_BYTES,
        incomingBytes: 1,
      }),
    ).toBe(true);
  });

  it("truncates filenames by Unicode code point", () => {
    const name = sanitizeAttachmentFileName(`${"a".repeat(254)}😀.txt`);

    expect(name).toHaveLength(254);
    expect(name.endsWith("a")).toBe(true);
    expect(() => encodeURIComponent(name)).not.toThrow();
  });
});
