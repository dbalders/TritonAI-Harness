import { expect, it, vi } from "vite-plus/test";
import type { VideoSource } from "expo-video";
import { makeVideoSourceRenewal, mayResumeVideoPlayback } from "./videoSourceRenewal";

function fixture() {
  const sources: VideoSource[] = [];
  let rate = 1;
  const player = {
    currentTime: 0,
    get playbackRate() {
      return rate;
    },
    set playbackRate(value: number) {
      rate = value;
      // The installed iOS Expo bridge writes AVPlayer.rate from this setter.
      player.playing = value !== 0;
    },
    playing: false,
    pause: vi.fn(() => {
      player.playing = false;
    }),
    play: vi.fn(() => {
      player.playing = true;
    }),
    replaceAsync: vi.fn(async (source: VideoSource) => {
      sources.push(source);
      player.currentTime = 0;
      player.playbackRate = 1;
    }),
  };
  const loader = makeVideoSourceRenewal(player);
  const controller = new AbortController();
  const options = { signal: controller.signal, playInitially: true, canPlay: () => true };
  return { player, sources, loader, controller, options };
}

it.each([false, true])(
  "preserves position, rate and playing=%s when a signature renews",
  async (playing) => {
    const { player, loader, options, sources } = fixture();
    await loader.replace("signed:first", options);
    player.currentTime = 73;
    player.playbackRate = 1.5;
    player.playing = playing;
    await loader.replace("signed:renewed", options);
    expect(sources).toEqual([
      { uri: "signed:first", contentType: "progressive" },
      { uri: "signed:renewed", contentType: "progressive" },
    ]);
    expect(player.currentTime).toBe(73);
    expect(player.playbackRate).toBe(1.5);
    expect(player.playing).toBe(playing);
  },
);

it("serializes rapid renewals without letting an obsolete replacement reset playback", async () => {
  const { player, loader, options, sources } = fixture();
  await loader.replace("signed:first", options);
  player.currentTime = 73;
  player.playbackRate = 1.5;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  player.replaceAsync.mockImplementationOnce(async (source) => {
    sources.push(source);
    entered.resolve();
    await release.promise;
    player.currentTime = 0;
  });
  const oldController = new AbortController();
  const obsolete = loader.replace("signed:obsolete", { ...options, signal: oldController.signal });
  await entered.promise;
  oldController.abort();
  const latest = loader.replace("signed:latest", options);
  expect(sources).toHaveLength(2);
  release.resolve();
  expect(await obsolete).toBe(false);
  expect(await latest).toBe(true);
  expect(sources.at(-1)).toEqual({ uri: "signed:latest", contentType: "progressive" });
  expect(player.currentTime).toBe(73);
  expect(player.playbackRate).toBe(1.5);
  expect(player.playing).toBe(true);
});

it("keeps the saved position for a manual retry after a rejected replacement", async () => {
  const { player, loader, options } = fixture();
  await loader.replace("signed:first", options);
  player.currentTime = 73;
  player.playbackRate = 1.5;
  player.playing = false;
  player.replaceAsync.mockImplementationOnce(async () => {
    player.currentTime = 0;
    throw new Error("range failed");
  });
  await expect(loader.replace("signed:failed", options)).rejects.toThrow("range failed");
  await loader.replace("signed:manual", options);
  expect(player.currentTime).toBe(73);
  expect(player.playbackRate).toBe(1.5);
  expect(player.playing).toBe(false);
});

it("does not resume after dismissal or when the app becomes inactive during replacement", async () => {
  const { player, loader, options } = fixture();
  await loader.replace("signed:first", options);
  player.currentTime = 73;
  await loader.replace("signed:background", { ...options, canPlay: () => false });
  expect(player.currentTime).toBe(73);
  expect(player.playing).toBe(false);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  player.replaceAsync.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
  });
  const pending = loader.replace("signed:dismissed", options);
  await entered.promise;
  loader.dispose();
  release.resolve();
  expect(await pending).toBe(false);
  expect(player.playing).toBe(false);
  expect(await loader.replace("signed:too-late", options)).toBe(false);
});

it.each([false, true])(
  "keeps Android requested playing=%s through a buffering/range failure",
  async (requested) => {
    const { player, loader, options } = fixture();
    await loader.replace("signed:first", options);
    player.currentTime = 73;
    player.playing = false;
    await loader.replace("signed:recovered", { ...options, playingIntent: () => requested });
    expect(player.currentTime).toBe(73);
    expect(player.playing).toBe(requested);
  },
);

it.each([
  { platform: "android", appState: "inactive", focused: true, paused: false, expected: false },
  { platform: "android", appState: "background", focused: false, paused: false, expected: false },
  { platform: "android", appState: "background", focused: true, paused: true, expected: false },
  { platform: "ios", appState: "background", focused: true, paused: false, expected: false },
  { platform: "android", appState: "background", focused: true, paused: false, expected: true },
])("honors current lifecycle eligibility during fullscreen renewal: %j", async (transition) => {
  const { player, loader, options } = fixture();
  let state = {
    platform: transition.platform,
    appState: "active",
    focused: true,
    paused: false,
    fullscreen: true,
  };
  const currentOptions = { ...options, canPlay: () => mayResumeVideoPlayback(state) };
  await loader.replace("signed:first", currentOptions);
  player.currentTime = 73;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  player.replaceAsync.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
  });
  const pending = loader.replace("signed:renewed", currentOptions);
  await entered.promise;
  state = { ...state, ...transition };
  player.pause();
  release.resolve();
  expect(await pending).toBe(true);
  expect(player.currentTime).toBe(73);
  expect(player.playing).toBe(transition.expected);
});
