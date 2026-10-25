import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { useState } from "react";
import { renewalVideoBase64 } from "../../../test/fixtures/signed-url-renewal";
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
  const bytes = Uint8Array.from(atob(renewalVideoBase64), (value) => value.charCodeAt(0));
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

it("stops automatic renewal for an unplayable resource until the user retries", async () => {
  const urls = [0, 1, 2, 3].map(() =>
    URL.createObjectURL(new Blob(["synthetic invalid video"], { type: "video/webm" })),
  );
  using _urls = { [Symbol.dispose]: () => urls.forEach((url) => URL.revokeObjectURL(url)) };
  const renewed = vi.fn();
  function BrokenVideo() {
    const [index, setIndex] = useState(0);
    return (
      <MediaVideoPlayer
        src={urls[index]!}
        label="Broken clip"
        onRetry={async () => {
          renewed();
          setIndex((current) => current + 1);
        }}
      />
    );
  }
  await using screen = await render(<BrokenVideo />);
  await expect.element(screen.getByRole("alert")).toBeVisible();
  expect(renewed).toHaveBeenCalledTimes(1);
  await screen.getByRole("button", { name: "Retry video" }).click();
  await expect.element(screen.getByRole("alert")).toBeVisible();
  expect(renewed).toHaveBeenCalledTimes(2);
});
