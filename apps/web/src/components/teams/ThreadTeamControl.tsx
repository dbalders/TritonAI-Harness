import { BookOpenIcon, ShareIcon, UsersIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuTrigger } from "../ui/menu";

/** Thread header entry to share with a team or add team memory; both open review dialogs. */
export function ThreadTeamControl({
  presentation,
  onShare,
  onAddMemory,
}: {
  presentation: "toolbar" | "menu";
  onShare: () => void;
  onAddMemory: () => void;
}) {
  const density = presentation === "menu" ? "touch" : "default";
  const items = (
    <>
      <MenuItem density={density} onClick={onShare}>
        <ShareIcon aria-hidden="true" className="size-4" />
        <MenuItemLabel>Share text to a team…</MenuItemLabel>
      </MenuItem>
      <MenuItem density={density} onClick={onAddMemory}>
        <BookOpenIcon aria-hidden="true" className="size-4" />
        <MenuItemLabel>Add team memory to message…</MenuItemLabel>
      </MenuItem>
    </>
  );
  if (presentation === "menu") return items;
  return (
    <Menu>
      <MenuTrigger render={<Button aria-label="Team" size="xs" variant="outline" />}>
        <UsersIcon aria-hidden="true" className="size-3.5" />
        <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
          Team
        </span>
      </MenuTrigger>
      <MenuPopup align="end">{items}</MenuPopup>
    </Menu>
  );
}
