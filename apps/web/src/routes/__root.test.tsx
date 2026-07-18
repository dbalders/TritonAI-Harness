import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({
  Outlet: () => null,
  createRootRoute: (options: object) => ({
    ...options,
    useRouteContext: () => ({ authGateState: { status: "authenticated" } }),
  }),
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: "/" }),
  useNavigate: () => vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => null,
}));

vi.mock("../components/AppSidebarLayout", () => ({
  AppSidebarLayout: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("../components/CommandPalette", () => ({
  CommandPalette: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("../components/cloud/RelayClientInstallDialog", () => ({
  RelayClientInstallDialog: () => null,
}));

vi.mock("../components/desktop/SshPasswordPromptDialog", () => ({
  SshPasswordPromptDialog: () => null,
}));

vi.mock("../components/SlowRpcRequestToastCoordinator", () => ({
  SlowRpcRequestToastCoordinator: () => null,
}));

vi.mock("../components/ui/toast", () => ({
  AnchoredToastProvider: ({ children }: { children: React.ReactNode }) => children,
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
  stackedThreadToast: vi.fn(),
  toastManager: { add: vi.fn() },
}));

vi.mock("../firstRunOnboarding", () => ({
  TritonAiFirstRunOnboardingBootstrap: () => null,
}));

vi.mock("../hooks/useSettings", () => ({
  useClientSettings: () => ({}),
}));

vi.mock("../state/entities", () => ({
  readProject: () => null,
  setActiveEnvironmentId: vi.fn(),
  useActiveEnvironmentId: () => null,
}));

vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironment: () => null,
}));

vi.mock("../state/server", () => ({
  primaryServerConfigAtom: Symbol("primaryServerConfigAtom"),
  primaryServerConfigEventAtom: Symbol("primaryServerConfigEventAtom"),
  primaryServerWelcomeAtom: Symbol("primaryServerWelcomeAtom"),
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

vi.mock("../components/ProviderUpdateLaunchNotification", () => ({
  ProviderUpdateLaunchNotification: () => <div data-provider-update-launch-notification />,
}));

import { RootRouteView } from "./__root";

it("does not render provider update launch notifications for an authenticated root", () => {
  const markup = renderToStaticMarkup(<RootRouteView />);

  expect(markup).not.toContain("data-provider-update-launch-notification");
});
