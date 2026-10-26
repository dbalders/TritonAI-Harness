import type { VideoPlayer } from "expo-video";

type Player = Pick<
  VideoPlayer,
  "currentTime" | "playbackRate" | "playing" | "pause" | "play" | "replaceAsync"
>;

export function mayResumeVideoPlayback(state: {
  readonly platform: string;
  readonly appState: string | null;
  readonly focused: boolean;
  readonly paused: boolean;
  readonly fullscreen: boolean;
}): boolean {
  return (
    state.focused &&
    !state.paused &&
    (state.appState === "active" ||
      (state.platform === "android" && state.fullscreen && state.appState === "background"))
  );
}

/** Native replacements cannot be aborted; serialize them and restore only the latest request. */
export function makeVideoSourceRenewal(player: Player) {
  let generation = 0;
  let disposed = false;
  let loaded = false;
  let queue = Promise.resolve();
  let resume: { time: number; rate: number; playing: boolean } | null = null;
  return {
    replace(
      uri: string,
      options: {
        readonly signal: AbortSignal;
        readonly playInitially: boolean;
        readonly playingIntent?: () => boolean;
        readonly canPlay: () => boolean;
      },
    ): Promise<boolean> {
      if (disposed || options.signal.aborted) return Promise.resolve(false);
      const request = ++generation;
      if (loaded && resume === null)
        resume = {
          time: player.currentTime,
          rate: player.playbackRate,
          playing: options.playingIntent?.() ?? player.playing,
        };
      const current = () => !disposed && request === generation && !options.signal.aborted;
      const replacing = queue.then(async () => {
        if (!current()) return false;
        if (options.playingIntent === undefined) player.pause();
        await player.replaceAsync({ uri, contentType: "progressive" });
        if (!current()) return false;
        const playback = resume;
        const shouldPlay =
          playback === null
            ? options.playInitially
            : (options.playingIntent?.() ?? playback.playing);
        if (playback !== null) {
          player.currentTime = Number.isFinite(playback.time) ? playback.time : 0;
          player.playbackRate = playback.rate;
        }
        loaded = true;
        resume = null;
        // Expo's iOS rate setter writes AVPlayer.rate and can start a paused item.
        if (shouldPlay && options.canPlay()) player.play();
        else player.pause();
        return true;
      });
      queue = replacing.then(
        () => undefined,
        () => undefined,
      );
      return replacing;
    },
    dispose() {
      disposed = true;
      generation += 1;
    },
  };
}
