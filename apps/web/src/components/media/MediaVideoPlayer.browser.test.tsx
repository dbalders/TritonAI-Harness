import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import clipUrl from "../../../test/fixtures/signed-url-renewal.webm?url";
import { MediaVideoPlayer } from "./MediaVideoPlayer";

const metadataReady = (video: HTMLVideoElement) =>
  video.readyState >= 1
    ? Promise.resolve()
    : new Promise<void>((resolve) =>
        video.addEventListener("loadedmetadata", () => resolve(), { once: true }),
      );
const seekFinished = (video: HTMLVideoElement) =>
  !video.seeking
    ? Promise.resolve()
    : new Promise<void>((resolve) =>
        video.addEventListener("seeked", () => resolve(), { once: true }),
      );

it("keeps paused position and playing position when the signed source renews", async () => {
  const bytes = await (await fetch(clipUrl)).arrayBuffer();
  const urls = [0, 1, 2].map(() => URL.createObjectURL(new Blob([bytes], { type: "video/webm" })));
  using _urls = { [Symbol.dispose]: () => urls.forEach((url) => URL.revokeObjectURL(url)) };
  const player = (src: string) => <MediaVideoPlayer src={src} label="Synthetic renewal clip" />;
  await using screen = await render(player(urls[0]!));
  const video = screen.container.querySelector("video")!;
  await metadataReady(video);
  await screen.getByLabelText("Synthetic renewal clip").click();
  await video.play();
  video.pause();
  video.currentTime = 7;
  await seekFinished(video);
  const pausedMetadata = new Promise<void>((resolve) =>
    video.addEventListener("loadedmetadata", () => resolve(), { once: true }),
  );
  await screen.rerender(player(urls[1]!));
  await pausedMetadata;
  await seekFinished(video);
  expect(video.currentTime).toBeCloseTo(7, 0);
  expect(video.paused).toBe(true);

  video.playbackRate = 1.25;
  await video.play();
  const position = video.currentTime;
  const playingMetadata = new Promise<void>((resolve) =>
    video.addEventListener("loadedmetadata", () => resolve(), { once: true }),
  );
  await screen.rerender(player(urls[2]!));
  await playingMetadata;
  await seekFinished(video);
  if (video.paused)
    await new Promise<void>((resolve) =>
      video.addEventListener("playing", () => resolve(), { once: true }),
    );
  expect(video.currentTime).toBeGreaterThanOrEqual(position - 0.25);
  expect(video.playbackRate).toBe(1.25);
  expect(video.paused).toBe(false);
});
