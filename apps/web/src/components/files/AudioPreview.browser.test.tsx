import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { AudioPreview } from "./AudioPreview";

it("keeps downloaded audio seekable after the original URL becomes unavailable", async () => {
  const bytes = new Uint8Array(44 + 8_000 * 2 * 4);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true);
  view.setUint32(28, 16_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, bytes.length - 44, true);
  const original = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(original) };
  await using screen = await render(
    <AudioPreview src={original} name="Synthetic audio" revision="file-1" />,
  );
  const audio = screen.container.querySelector("audio")!;
  if (audio.readyState < 1)
    await new Promise<void>((resolve) =>
      audio.addEventListener("loadedmetadata", () => resolve(), { once: true }),
    );
  expect(audio.src).not.toBe(original);
  expect(audio.duration).toBeCloseTo(4);
  URL.revokeObjectURL(original);
  const admitted = audio.src;
  await screen.rerender(
    <AudioPreview
      src="https://synthetic.invalid/renewed.wav"
      name="Synthetic audio"
      revision="file-1"
    />,
  );
  expect(audio.src).toBe(admitted);
  audio.currentTime = 2;
  if (audio.seeking)
    await new Promise<void>((resolve) =>
      audio.addEventListener("seeked", () => resolve(), { once: true }),
    );
  expect(audio.currentTime).toBeCloseTo(2);
  expect(audio.error).toBeNull();

  const changed = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  using _changed = { [Symbol.dispose]: () => URL.revokeObjectURL(changed) };
  await screen.getByLabelText("Synthetic audio").click();
  await audio.play();
  await screen.rerender(<AudioPreview src={changed} name="Synthetic audio" revision="file-2" />);
  expect(audio.src).toBe(admitted);
  const changedMetadata = new Promise<void>((resolve) =>
    audio.addEventListener("loadedmetadata", () => resolve(), { once: true }),
  );
  audio.pause();
  await changedMetadata;
  expect(audio.src).not.toBe(admitted);
  expect(audio.src).not.toBe(changed);
  expect(audio.duration).toBeCloseTo(4);
});
