import { describe, expect, it, vi } from "vite-plus/test";

import { syncHostedBrowserWebviewAudio } from "./hostedBrowserWebviewAudio";

describe("syncHostedBrowserWebviewAudio", () => {
  it("mutes an offscreen preview", () => {
    const setAudioMuted = vi.fn();

    syncHostedBrowserWebviewAudio({ setAudioMuted }, false);

    expect(setAudioMuted).toHaveBeenCalledWith(true);
  });

  it("restores audio when the preview is visible", () => {
    const setAudioMuted = vi.fn();

    syncHostedBrowserWebviewAudio({ setAudioMuted }, true);

    expect(setAudioMuted).toHaveBeenCalledWith(false);
  });
});
