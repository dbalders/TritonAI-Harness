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
  const urls = [0, 1, 2, 3, 4, 5, 6].map(() =>
    URL.createObjectURL(new Blob(["synthetic invalid video"], { type: "video/webm" })),
  );
  using _urls = { [Symbol.dispose]: () => urls.forEach((url) => URL.revokeObjectURL(url)) };
  const renewed = vi.fn();
  function BrokenVideo(props: { readonly poll?: number; readonly revision?: string }) {
    const [index, setIndex] = useState(0);
    return (
      <MediaVideoPlayer
        src={urls[index + (props.poll ?? 0)]!}
        revision={props.revision}
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
  await screen.rerender(<BrokenVideo poll={1} />);
  await expect.element(screen.getByRole("alert")).toBeVisible();
  expect(screen.container.querySelector("video")).toBeNull();
  await screen.rerender(<BrokenVideo poll={2} />);
  await expect.element(screen.getByRole("alert")).toBeVisible();
  expect(screen.container.querySelector("video")).toBeNull();
  expect(renewed).toHaveBeenCalledTimes(1);
  await screen.getByRole("button", { name: "Retry video" }).click();
  await expect.element(screen.getByRole("alert")).toBeVisible();
  expect(renewed).toHaveBeenCalledTimes(2);
  await screen.rerender(<BrokenVideo poll={2} revision="new-file-revision" />);
  await expect.element(screen.getByRole("alert")).toBeVisible();
  expect(renewed).toHaveBeenCalledTimes(3);
});

it("stays paused when the page becomes hidden while a renewed source loads", async () => {
  const bytes = Uint8Array.from(atob(renewalVideoBase64), (value) => value.charCodeAt(0));
  const urls = [0, 1].map(() => URL.createObjectURL(new Blob([bytes], { type: "video/webm" })));
  using _urls = { [Symbol.dispose]: () => urls.forEach((url) => URL.revokeObjectURL(url)) };
  await using screen = await render(
    <MediaVideoPlayer src={urls[0]!} label="Hidden renewal clip" />,
  );
  const video = screen.container.querySelector("video")!;
  await metadataReady(video);
  await screen.getByLabelText("Hidden renewal clip").click();
  await video.play();
  let hidden = false;
  using _hidden = vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const metadata = new Promise<void>((resolve) =>
    video.addEventListener("loadedmetadata", () => resolve(), { once: true }),
  );
  video.addEventListener(
    "loadstart",
    () => {
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    { once: true },
  );
  await screen.rerender(<MediaVideoPlayer src={urls[1]!} label="Hidden renewal clip" />);
  await metadata;
  await seekFinished(video);
  expect(document.hidden).toBe(true);
  expect(video.paused).toBe(true);
});

it("retains the original playhead while a second renewal replaces a loading source", async () => {
  const bytes = Uint8Array.from(atob(renewalVideoBase64), (value) => value.charCodeAt(0));
  const waiting = new MediaSource();
  const urls = [
    URL.createObjectURL(new Blob([bytes], { type: "video/webm" })),
    URL.createObjectURL(waiting),
    URL.createObjectURL(new Blob([bytes], { type: "video/webm" })),
  ];
  using _urls = { [Symbol.dispose]: () => urls.forEach((url) => URL.revokeObjectURL(url)) };
  const player = (src: string) => <MediaVideoPlayer src={src} label="Overlapping renewal clip" />;
  await using screen = await render(player(urls[0]!));
  const video = screen.container.querySelector("video")!;
  await metadataReady(video);
  await screen.getByLabelText("Overlapping renewal clip").click();
  video.currentTime = 7;
  await seekFinished(video);
  video.playbackRate = 1.25;
  await video.play();
  const position = video.currentTime;
  const sourceOpened = new Promise<void>((resolve) =>
    waiting.addEventListener("sourceopen", () => resolve(), { once: true }),
  );
  await screen.rerender(player(urls[1]!));
  await sourceOpened;
  expect(video.readyState).toBe(0);
  expect(video.currentTime).toBe(0);
  expect(video.paused).toBe(true);
  const metadata = new Promise<void>((resolve) =>
    video.addEventListener("loadedmetadata", () => resolve(), { once: true }),
  );
  await screen.rerender(player(urls[2]!));
  await metadata;
  await seekFinished(video);
  if (video.paused)
    await new Promise<void>((resolve) =>
      video.addEventListener("playing", () => resolve(), { once: true }),
    );
  expect(video.currentTime).toBeGreaterThanOrEqual(position - 0.25);
  expect(video.playbackRate).toBe(1.25);
  expect(video.paused).toBe(false);
});

it("keeps the pending playhead when a renewed source fails before loading", async () => {
  const bytes = Uint8Array.from(atob(renewalVideoBase64), (value) => value.charCodeAt(0));
  const urls = [
    URL.createObjectURL(new Blob([bytes], { type: "video/webm" })),
    URL.createObjectURL(new Blob(["invalid replacement"], { type: "video/webm" })),
    URL.createObjectURL(new Blob([bytes], { type: "video/webm" })),
  ];
  using _urls = { [Symbol.dispose]: () => urls.forEach((url) => URL.revokeObjectURL(url)) };
  const refresh = vi.fn();
  function Player(props: { readonly broken?: boolean }) {
    const [recovered, setRecovered] = useState(false);
    return (
      <MediaVideoPlayer
        src={urls[recovered ? 2 : props.broken ? 1 : 0]!}
        label="Recovered renewal clip"
        onRetry={async () => {
          refresh();
          setRecovered(true);
        }}
      />
    );
  }
  await using screen = await render(<Player />);
  const initial = screen.container.querySelector("video")!;
  await metadataReady(initial);
  await screen.getByLabelText("Recovered renewal clip").click();
  initial.currentTime = 7;
  await seekFinished(initial);
  initial.playbackRate = 1.25;
  await initial.play();
  const position = initial.currentTime;
  await screen.rerender(<Player broken />);
  await vi.waitFor(() => {
    const recovered = screen.container.querySelector("video");
    expect(recovered?.src).toBe(urls[2]);
    expect(recovered?.readyState).toBeGreaterThanOrEqual(1);
  });
  const recovered = screen.container.querySelector("video")!;
  await seekFinished(recovered);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(recovered.currentTime).toBeGreaterThanOrEqual(position - 0.25);
  expect(recovered.playbackRate).toBe(1.25);
  expect(recovered.paused).toBe(false);
});
