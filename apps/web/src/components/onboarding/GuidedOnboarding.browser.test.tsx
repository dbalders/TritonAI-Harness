import { act, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { GuidedOnboarding } from "./GuidedOnboarding";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  open: vi.fn<() => Promise<boolean>>(),
  enabled: true,
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("tour"),
}));
vi.mock("../../hooks/useSettings", () => ({
  getClientSettings: () => ({ experimentalGuidedTourEnabled: mocks.enabled }),
}));
vi.mock("../../onboarding/gettingStartedState", () => ({ openGettingStarted: () => mocks.open() }));

function resetMocks() {
  mocks.navigate.mockClear();
  mocks.open.mockReset().mockResolvedValue(true);
  mocks.enabled = true;
}
describe("saved guided tour links", () => {
  it("opens the saved chapters in the ordinary workspace", async () => {
    resetMocks();
    await using _screen = await render(<GuidedOnboarding />, { router: false });
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/", replace: true });
  });
  it("offers retry when progress cannot be saved", async () => {
    resetMocks();
    mocks.open.mockResolvedValueOnce(false);
    await using screen = await render(<GuidedOnboarding />, { router: false });
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("Could not open your saved chapters.");
    expect(mocks.navigate).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Try again" }).click();
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/", replace: true });
  });
  it("does not navigate after leaving while progress saves", async () => {
    resetMocks();
    let resolve!: (saved: boolean) => void;
    mocks.open.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await using screen = await render(<GuidedOnboarding />, { router: false });
    await screen.unmount();
    await act(() => resolve(true));
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
