import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render, type Screen } from "../../../test/render";
import { SecretInput } from "./SecretInput";

const input = (screen: Screen) => screen.getByLabelText("API key", { exact: true });

function settings(onCommit: (value: string) => void) {
  return (
    <>
      <SecretInput aria-label="API key" configured value="" onCommit={onCommit} />
      <button type="button">Another setting</button>
    </>
  );
}

const blur = (screen: Screen) =>
  userEvent.click(screen.getByRole("button", { name: "Another setting", exact: true }));

describe("SecretInput", () => {
  it("preserves a configured secret on empty edits and commits a replacement", async () => {
    const onCommit = vi.fn();
    await using screen = await render(settings(onCommit));
    await expect.element(input(screen)).toHaveAttribute("type", "password");

    await userEvent.click(input(screen));
    await blur(screen);
    expect(onCommit).not.toHaveBeenCalled();

    // These cases verify draft/commit boundaries, so fill in one browser command.
    // A timed-out per-character type can keep sending keys into the following test.
    await userEvent.fill(input(screen), "replacement");
    await expect.element(input(screen)).toHaveValue("replacement");
    expect(onCommit).not.toHaveBeenCalled();
    await blur(screen);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("replacement");
    await expect.element(input(screen)).toHaveValue("");
  });

  it("keeps an in-progress replacement when settings refresh", async () => {
    const onCommit = vi.fn();
    const ui = () => settings(onCommit);
    await using screen = await render(ui());

    await userEvent.fill(input(screen), "replacement");
    await expect.element(input(screen)).toHaveValue("replacement");
    await screen.rerender(ui());
    await expect.element(input(screen)).toHaveValue("replacement");
    expect(onCommit).not.toHaveBeenCalled();

    await expect.element(input(screen)).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("replacement");
    await expect.element(input(screen)).not.toHaveFocus();
    await expect.element(input(screen)).toHaveValue("");
  });
});
