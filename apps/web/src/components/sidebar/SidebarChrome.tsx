import { useTeamsEnabled } from "../teams/useTeamsEnabled";
import {
  ArrowLeftIcon,
  ChartNoAxesColumnIcon,
  CircleHelpIcon,
  LightbulbIcon,
  UsersIcon,
  SettingsIcon,
} from "lucide-react";
import { type ReactElement, type ReactNode, memo } from "react";
import { SidebarAccount } from "../teams/SidebarAccount";
import { usePendingTeamInvitationCount } from "../teams/useTeamsController";
import { useUcsdAccount } from "../../hooks/useUcsdAccount";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId, usePullRequestsSupported } from "../../state/environments";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { observeResize } from "~/lib/observeResize";
import { GettingStartedSidebarEntry } from "../onboarding/GettingStartedHost";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel = resolveEnvironmentIdentificationPillLabel(stageLabel);

  return (
    <div
      className={cn(
        "@container/sidebar-header relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-1 px-3 md:px-0",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <div className="relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center md:hidden">
        <SidebarTrigger
          variant={backdropVariant ? "media-navigation" : "ghost"}
          className="relative top-auto translate-y-0"
          aria-label="Toggle main sidebar"
        />
      </div>
      <div className="relative z-10 flex h-8 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5">
        <SidebarBrand onBackdrop={backdropVariant !== null} />
        {pillLabel ? (
          <div className="ml-1 flex h-7 items-center">
            <span
              data-environment-identification="pill"
              className="whitespace-nowrap text-xs font-medium text-muted-foreground"
            >
              ({pillLabel})
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
});

export function SidebarBrandWidthProbe({
  onWidthChange,
}: {
  onWidthChange: (width: number) => void;
}) {
  const observeWidth = (probe: HTMLDivElement) => {
    return observeResize(probe, ([entry]) => {
      if (entry) onWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
    });
  };

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none invisible fixed top-0 left-0 flex w-max border-r border-transparent pr-3"
      ref={observeWidth}
    >
      <div className="ml-[var(--workspace-titlebar-content-left)] flex">
        <SidebarBrandIdentity onBackdrop={false} />
      </div>
    </div>
  );
}

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset md:flex",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <SidebarBrandIdentity onBackdrop={onBackdrop} />
    </Link>
  );
}

function SidebarBrandIdentity({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <span
      className={cn(
        "truncate text-sm font-medium tracking-tight",
        onBackdrop ? "text-white/85" : "text-foreground",
      )}
    >
      TritonAI
    </span>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
  count = 0,
  countLabel,
  tooltip = true,
  render,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  count?: number;
  countLabel?: string;
  /** Off where the icon already says enough. */
  tooltip?: boolean;
  render?: ReactElement;
}) {
  const button = (
    <SidebarMenuButton
      aria-label={count > 0 && countLabel ? `${label}, ${countLabel}` : label}
      data-getting-started-target={label === "Settings" ? "settings" : undefined}
      onClick={onClick}
      render={render}
      size="icon"
    >
      {icon}
    </SidebarMenuButton>
  );
  return (
    <SidebarMenuItem className="relative shrink-0">
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger render={button} />
          <TooltipPopup side="top">{label}</TooltipPopup>
        </Tooltip>
      ) : (
        button
      )}
      {count > 0 ? (
        <span aria-hidden className="pointer-events-none absolute -top-1 -right-1">
          <Badge size="sm">{count > 9 ? "9+" : count}</Badge>
        </span>
      ) : null}
    </SidebarMenuItem>
  );
}

function SidebarIdeasItem({ onClick }: { onClick: () => void }) {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) return null;
  return (
    <SidebarUtilityItem
      icon={<LightbulbIcon />}
      label="Ideas"
      onClick={onClick}
      tooltip={false}
      render={<Link to="/ideas" data-getting-started-target="ideas" />}
    />
  );
}

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu({
  pendingTeamInvitations = 0,
}: {
  pendingTeamInvitations?: number;
}) {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const isOnHelpPage = useLocation({ select: (location) => location.pathname === "/help" });
  const pullRequestsSupported = usePullRequestsSupported();
  const teamsEnabled = useTeamsEnabled(usePrimaryEnvironmentId());
  const closeMobileSidebar = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };
  const handlePullRequestsClick = () => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  };
  const handleSettingsClick = () => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  };

  const handleUsageClick = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  };

  const handleBackClick = () => {
    closeMobileSidebar();
    void navigateToMainApp();
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={isOnHelpPage}
            onClick={closeMobileSidebar}
            render={<Link to="/help" />}
          >
            <CircleHelpIcon />
            <span>Help</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <SidebarMenu className="flex-row items-center">
        {isOnUtilityPage ? (
          <SidebarMenuItem className="min-w-0 flex-1">
            <SidebarMenuButton onClick={handleBackClick}>
              <ArrowLeftIcon />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : (
          <>
            <SidebarUtilityItem
              icon={<SettingsIcon />}
              label="Settings"
              onClick={handleSettingsClick}
            />
            {pullRequestsSupported ? (
              <SidebarUtilityItem
                icon={<PullRequestGlyph.pullRequest />}
                label="Pull Requests"
                onClick={handlePullRequestsClick}
              />
            ) : null}
            {teamsEnabled ? (
              <SidebarUtilityItem
                icon={<UsersIcon />}
                label="Teams"
                count={pendingTeamInvitations}
                countLabel={`${pendingTeamInvitations} pending ${pendingTeamInvitations === 1 ? "invitation" : "invitations"}`}
                onClick={() => {
                  closeMobileSidebar();
                  void navigate({ to: "/teams" });
                }}
              />
            ) : null}
            <SidebarUtilityItem
              icon={<ChartNoAxesColumnIcon />}
              label="Usage"
              onClick={handleUsageClick}
            />
            <SidebarIdeasItem onClick={closeMobileSidebar} />
          </>
        )}
        <SidebarUpdatePill />
      </SidebarMenu>
    </div>
  );
});

/** The account and the Teams item's invitation count share one account check. */
function SidebarAccountFooter({ environmentId }: { environmentId: EnvironmentId }) {
  const account = useUcsdAccount(environmentId);
  const teamsEnabled = useTeamsEnabled(environmentId);
  const pendingTeamInvitations = usePendingTeamInvitationCount(environmentId, account);
  return (
    <>
      <SidebarAccount {...account} teamsEnabled={teamsEnabled} />
      <SidebarUtilityMenu pendingTeamInvitations={pendingTeamInvitations} />
    </>
  );
}

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SidebarFooter>
      <SidebarThreadUndoNotice />
      <GettingStartedSidebarEntry />
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      {environmentId ? (
        <SidebarAccountFooter key={environmentId} environmentId={environmentId} />
      ) : (
        <SidebarUtilityMenu />
      )}
    </SidebarFooter>
  );
});
