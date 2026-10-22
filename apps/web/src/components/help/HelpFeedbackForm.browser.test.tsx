import { expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../../test/render";

const state = vi.hoisted(() => ({
  copy: vi.fn(async (_report: string, _label: string) => true),
  openExternal: vi.fn(async (_url: string) => undefined),
}));
vi.mock(import("../../hooks/useCopyToClipboard"), async (original) => ({
  ...(await original()),
  writeTextToClipboard: state.copy as never,
}));
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  ensureLocalApi: (() => ({ shell: { openExternal: state.openExternal } })) as never,
}));

import { HelpFeedbackForm } from "./HelpFeedbackForm";
import { HELP_ISSUE_TRACKER_URL } from "./helpLinks";

const conversation = [
  { role: "user", content: "My private Help question" },
  { role: "assistant", content: "Try Providers." },
] as const;

function setup() {
  state.copy.mockClear();
  state.openExternal.mockClear();
}

const renderForm = () => render(<HelpFeedbackForm context={null} conversation={conversation} />);
const preview = (screen: Screen) => screen.container.querySelector("pre")!.textContent;
const button = (screen: Screen, label: string) =>
  [...screen.container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  )!;
const includeConversation = (screen: Screen) =>
  screen.container.querySelector<HTMLElement>('[role="checkbox"]')!;

async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("edits structured fields and copies exactly the preview, with conversation off by default", async () => {
  setup();
  await using screen = await renderForm();
  expect(includeConversation(screen).getAttribute("aria-checked")).toBe("false");
  expect(preview(screen)).not.toContain("My private Help question");
  for (const [id, value] of [
    ["summary", "Provider stopped responding"],
    ["steps", "Send a question"],
    ["expected", "An answer"],
    ["actual", "No answer"],
  ] as const) {
    await type(
      screen.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `#help-feedback-${id}`,
      )!,
      value,
    );
    expect(preview(screen)).toContain(value);
  }
  expect(state.copy).not.toHaveBeenCalled();
  expect(state.openExternal).not.toHaveBeenCalled();
  await act(async () => button(screen, "Copy report").click());
  expect(state.copy).toHaveBeenLastCalledWith(preview(screen), "Help report");
  expect(screen.container.querySelector('[role="status"]')?.textContent).toBe("Report copied.");
  await act(() => includeConversation(screen).click());
  expect(includeConversation(screen).getAttribute("aria-checked")).toBe("true");
  expect(preview(screen)).toContain("My private Help question");
  await act(async () => button(screen, "Copy report").click());
  expect(state.copy).toHaveBeenLastCalledWith(preview(screen), "Help report");
});

it("downloads the exact preview and opens the tracker manually with no report in the URL", async () => {
  setup();
  await using screen = await renderForm();
  using createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:help-report");
  using revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  const downloads: HTMLAnchorElement[] = [];
  const deferredConsumption = Promise.withResolvers<boolean>();
  // Records the download link instead of letting the browser save a file.
  using _download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this);
    // Model a download consumer that starts after click returns.
    queueMicrotask(() => deferredConsumption.resolve(revokeObjectURL.mock.calls.length === 0));
  });
  await act(() => button(screen, "Download report").click());
  expect(await deferredConsumption.promise).toBe(true);
  const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
  expect(await blob.text()).toBe(preview(screen));
  expect(downloads).toHaveLength(1);
  expect(downloads[0]!.download).toBe("tritonai-help-report.md");
  await expect.poll(() => revokeObjectURL.mock.calls).toEqual([["blob:help-report"]]);
  expect(state.openExternal).not.toHaveBeenCalled();
  await act(async () => button(screen, "Open issue tracker").click());
  expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(HELP_ISSUE_TRACKER_URL);
});
