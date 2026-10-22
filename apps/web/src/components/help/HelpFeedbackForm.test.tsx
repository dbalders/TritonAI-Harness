import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { HelpFeedbackForm } from "./HelpFeedbackForm";
import { HELP_ISSUE_TRACKER_URL } from "./helpLinks";

const state = vi.hoisted(() => ({
  copy: vi.fn(async (_report: string) => true),
  openExternal: vi.fn(async (_url: string) => undefined),
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: state.copy }));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: state.openExternal } }),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/label", () => ({ Label: "label" }));
vi.mock("../ui/checkbox", () => ({ Checkbox: "input" }));

let renderer: ReactTestRenderer;
const conversation = [
  { role: "user", content: "My private Help question" },
  { role: "assistant", content: "Try Providers." },
] as const;
const preview = () => renderer.root.findByType("pre").children.join("");
const button = (label: string) =>
  renderer.root
    .findAll((node) => node.type === "button")
    .find((node) => node.children.includes(label))!;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.copy.mockClear();
  state.openExternal.mockClear();
  await act(() => {
    renderer = create(<HelpFeedbackForm context={null} conversation={conversation} />);
  });
});
afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

it("edits structured fields and copies exactly the preview, with conversation off by default", async () => {
  expect(renderer.root.findByProps({ id: "help-feedback-conversation" }).props.checked).toBe(false);
  expect(preview()).not.toContain("My private Help question");
  for (const [id, value] of [
    ["summary", "Provider stopped responding"],
    ["steps", "Send a question"],
    ["expected", "An answer"],
    ["actual", "No answer"],
  ]) {
    await act(() =>
      renderer.root
        .findByProps({ id: `help-feedback-${id}` })
        .props.onChange({ target: { value } }),
    );
    expect(preview()).toContain(value);
  }
  expect(state.copy).not.toHaveBeenCalled();
  expect(state.openExternal).not.toHaveBeenCalled();
  await act(async () => button("Copy report").props.onClick());
  expect(state.copy).toHaveBeenLastCalledWith(preview(), "Help report");
  await act(() =>
    renderer.root.findByProps({ id: "help-feedback-conversation" }).props.onCheckedChange(true),
  );
  expect(preview()).toContain("My private Help question");
  await act(async () => button("Copy report").props.onClick());
  expect(state.copy).toHaveBeenLastCalledWith(preview(), "Help report");
});

it("downloads the exact preview and opens the tracker manually with no report in the URL", async () => {
  const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
  const createObjectURL = vi.fn((_blob: Blob) => "blob:help-report");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  vi.stubGlobal("document", { createElement: vi.fn(() => anchor), body: { appendChild: vi.fn() } });
  await act(() => button("Download report").props.onClick());
  const blob = createObjectURL.mock.calls[0]?.[0];
  expect(await blob?.text()).toBe(preview());
  expect(anchor.click).toHaveBeenCalledTimes(1);
  expect(anchor.download).toBe("tritonai-help-report.md");
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:help-report");
  expect(state.openExternal).not.toHaveBeenCalled();
  await act(async () => button("Open issue tracker").props.onClick());
  expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(HELP_ISSUE_TRACKER_URL);
});
