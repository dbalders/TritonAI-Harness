import { act, render as renderComponent, type Screen } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import type { useUcsdAccount } from "../../hooks/useUcsdAccount";
import { SidebarAccount } from "./SidebarAccount";
let view: Screen | null = null;
let container: HTMLElement;
async function mount(ui: import("react").ReactNode) {
  if (view) await view.rerender(ui);
  else view = await renderComponent(ui, { router: false });
  container = view.container;
  return view;
}

function setup() {
  view = null;
}
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
  setup();
  await using _screen = await mount(<SidebarAccount {...account(false)} />);
  expect(container.textContent).toBe("");
});
it("keeps a connection error visible when account availability could not be checked", async () => {
  setup();
  await using _screen = await mount(
    <SidebarAccount {...account(false, "Connection unavailable")} />,
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Connection unavailable");
});
it("offers sign-in for a configured campus account", async () => {
  setup();
  const props = account(true);
  await using _screen = await mount(<SidebarAccount {...props} />);
  const button = container.querySelector("button")!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(props.controller.signIn).toHaveBeenCalledOnce();
});
