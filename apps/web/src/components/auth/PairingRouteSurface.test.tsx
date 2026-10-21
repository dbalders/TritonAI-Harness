import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { PairingRouteSurface } from "./PairingRouteSurface";

const pairing = vi.hoisted(() => ({
  token: null as string | null,
  submit: vi.fn(),
  strip: vi.fn(),
}));
vi.mock("../../environments/primary", () => ({
  peekPairingTokenFromUrl: () => pairing.token,
  stripPairingTokenFromUrl: pairing.strip,
  submitServerAuthCredential: pairing.submit,
}));
vi.mock("../../connection/onboarding", () => ({ connectPairing: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/standalone-page", () => ({
  StandalonePage: "main",
  StandalonePageHeader: "header",
}));
vi.mock("../ui/alert", () => ({ Alert: "aside", AlertDescription: "p" }));

let renderer: ReactTestRenderer | undefined;
let browser: EventTarget;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  browser = new EventTarget();
  vi.stubGlobal("window", browser);
  pairing.token = null;
  pairing.submit.mockReset().mockResolvedValue(undefined);
  pairing.strip.mockReset().mockImplementation(() => {
    pairing.token = null;
  });
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("pairs late links without a reload and never replays an already submitted URL token", async () => {
  const authenticated = vi.fn();
  await act(() => {
    renderer = create(
      <PairingRouteSurface
        auth={{
          policy: "loopback-browser",
          bootstrapMethods: [],
          sessionMethods: [],
          sessionCookieName: "session",
        }}
        onAuthenticated={authenticated}
      />,
    );
  });
  expect(pairing.submit).not.toHaveBeenCalled();
  const navigate = async (token: string) => {
    await act(() => {
      pairing.token = token;
      browser.dispatchEvent(new Event("hashchange"));
    });
  };
  await navigate("first-one-time-token");
  expect(pairing.submit).toHaveBeenCalledExactlyOnceWith("first-one-time-token");
  expect(authenticated).toHaveBeenCalledTimes(1);
  await navigate("first-one-time-token");
  expect(pairing.submit).toHaveBeenCalledTimes(1);
  await navigate("fresh-one-time-token");
  expect(pairing.submit).toHaveBeenLastCalledWith("fresh-one-time-token");
  expect(authenticated).toHaveBeenCalledTimes(2);
  expect(pairing.strip).toHaveBeenCalledTimes(2);
});
