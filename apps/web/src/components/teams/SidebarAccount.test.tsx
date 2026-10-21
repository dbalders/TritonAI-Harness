// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { useUcsdAccount } from "../../hooks/useUcsdAccount";
import { SidebarAccount } from "./SidebarAccount";
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const account = (configured: boolean, error: string | null = null) =>
  ({
    account: { configured, status: "signed-out" },
    busy: false,
    error,
    controller: { signIn: vi.fn() },
    canSignIn: true,
    canSignOut: true,
  }) as unknown as ReturnType<typeof useUcsdAccount>;
it("hides an unconfigured campus account footer", async () => {
  await act(async () => root.render(<SidebarAccount {...account(false)} />));
  expect(container.textContent).toBe("");
});
it("keeps a connection error visible when account availability could not be checked", async () => {
  await act(async () =>
    root.render(<SidebarAccount {...account(false, "Connection unavailable")} />),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Connection unavailable");
});
it("offers sign-in for a configured campus account", async () => {
  const props = account(true);
  await act(async () => root.render(<SidebarAccount {...props} />));
  const button = container.querySelector("button")!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(props.controller.signIn).toHaveBeenCalledOnce();
});
