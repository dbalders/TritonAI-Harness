import { LightbulbIcon } from "lucide-react";
import { memo, useCallback } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { useEnvironmentQuery } from "../../state/query";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

/** The Ideas entry under search, with a count of ideas added since the page was last opened. */
export const SidebarIdeasRow = memo(function SidebarIdeasRow() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const environmentId = usePrimaryEnvironmentId();
  const onIdeasPage = useLocation({ select: (location) => location.pathname === "/ideas" });
  const { data } = useEnvironmentQuery(
    environmentId ? serverEnvironment.ideas({ environmentId, input: {} }) : null,
  );
  const unseen = onIdeasPage ? 0 : (data?.unseenCount ?? 0);

  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/ideas" });
  }, [isMobile, navigate, setOpenMobile]);

  if (environmentId === null) return null;
  return (
    <SidebarMenu className="mt-1">
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={onIdeasPage}
          onClick={handleClick}
          aria-label={unseen > 0 ? `Ideas, ${unseen} new` : "Ideas"}
        >
          <LightbulbIcon />
          <span className="min-w-0 flex-1 truncate">Ideas</span>
          {unseen > 0 ? (
            <Badge size="sm" className="ml-auto">
              {unseen > 9 ? "9+" : unseen}
            </Badge>
          ) : null}
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
});
