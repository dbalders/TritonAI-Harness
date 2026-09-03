import {
  CheckIcon,
  CornerUpRightIcon,
  EllipsisIcon,
  ImageIcon,
  ListOrderedIcon,
  PaperclipIcon,
  PencilIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import type { QueuedComposerEntry } from "../../composerQueueStore";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";

export function QueuedComposerControl(props: {
  readonly entries: readonly QueuedComposerEntry[];
  readonly canSteer: boolean;
  readonly onSteer: (entryId: string) => void;
  readonly onRemove: (entryId: string) => void;
  readonly onEdit: (entryId: string, prompt: string) => void;
}) {
  const [editing, setEditing] = useState<{ readonly id: string; readonly prompt: string } | null>(
    null,
  );
  const visibleEntries = props.entries.filter((entry) => entry.status !== "dispatching");

  if (visibleEntries.length === 0) return null;

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        role="region"
        aria-label={`${visibleEntries.length} queued message${visibleEntries.length === 1 ? "" : "s"}`}
        aria-live="polite"
        data-chat-composer-queued-messages="true"
        className="p-1 pb-[calc(var(--chat-composer-attachment-overlap)+(--spacing(1)))] text-sm/5 [--composer-banner-icon-column:--spacing(6)]"
      >
        <ComposerBanner.Scroll className="max-h-40">
          <ComposerBanner.Children render={<ol />} aria-label="Queued messages" className="gap-0">
            {visibleEntries.map((entry) => {
              const failed = entry.status === "failed";
              const isEditing = editing?.id === entry.id;
              const attachmentCount = entry.images.length + entry.files.length;
              return (
                <ComposerBanner.Row
                  render={<li />}
                  key={entry.id}
                  className={cn("min-h-8 rounded-lg px-0.5", failed && "bg-destructive/5")}
                >
                  <ComposerBanner.Icon aria-hidden={false}>
                    {failed ? (
                      <TriangleAlertIcon
                        className="text-destructive"
                        aria-label="Queued message failed"
                      />
                    ) : attachmentCount > 0 ? (
                      entry.images.length > 0 ? (
                        <ImageIcon
                          aria-label={`${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`}
                        />
                      ) : (
                        <PaperclipIcon
                          aria-label={`${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`}
                        />
                      )
                    ) : (
                      <ListOrderedIcon aria-label="Queued message" />
                    )}
                  </ComposerBanner.Icon>
                  <ComposerBanner.Content className="text-foreground">
                    {entry.images.slice(0, 3).map((image) => (
                      <img
                        key={image.id}
                        src={image.previewUrl}
                        alt={image.name}
                        className="size-5 shrink-0 rounded border border-border/70 object-cover"
                      />
                    ))}
                    {isEditing ? (
                      <input
                        autoFocus
                        value={editing.prompt}
                        aria-label="Queued message text"
                        className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onChange={(event) =>
                          setEditing((current) =>
                            current ? { ...current, prompt: event.currentTarget.value } : null,
                          )
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setEditing(null);
                          if (
                            event.key === "Enter" &&
                            (editing.prompt.trim().length > 0 || attachmentCount > 0)
                          ) {
                            event.preventDefault();
                            props.onEdit(entry.id, editing.prompt);
                            setEditing(null);
                          }
                        }}
                      />
                    ) : (
                      <Tooltip>
                        <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
                          {entry.prompt.trim() ||
                            (attachmentCount === 1
                              ? "Message with attachment"
                              : `Message with ${attachmentCount} attachments`)}
                        </TooltipTrigger>
                        <TooltipPopup side="top" className="max-w-96 break-words">
                          {entry.error ?? (entry.prompt.trim() || "Attachment-only message")}
                        </TooltipPopup>
                      </Tooltip>
                    )}
                  </ComposerBanner.Content>
                  <ComposerBanner.Actions>
                    {isEditing ? (
                      <>
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost-muted"
                          disabled={editing.prompt.trim().length === 0 && attachmentCount === 0}
                          aria-label="Save queued message"
                          onClick={() => {
                            props.onEdit(entry.id, editing.prompt);
                            setEditing(null);
                          }}
                        >
                          <CheckIcon />
                        </Button>
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost-muted"
                          aria-label="Cancel editing queued message"
                          onClick={() => setEditing(null)}
                        >
                          <XIcon />
                        </Button>
                      </>
                    ) : (
                      <>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                type="button"
                                size="xs"
                                variant="ghost-muted"
                                disabled={!props.canSteer}
                                className="h-6 gap-1 px-1.5 font-normal"
                                aria-label={
                                  failed
                                    ? "Retry queued message as steer"
                                    : "Steer queued message now"
                                }
                                onClick={() => props.onSteer(entry.id)}
                              />
                            }
                          >
                            <CornerUpRightIcon className="size-3" />
                            {failed ? "Retry" : "Steer"}
                          </TooltipTrigger>
                          <TooltipPopup side="top">
                            {failed ? "Retry as steer" : "Steer now"}
                          </TooltipPopup>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                type="button"
                                size="icon-xs"
                                variant="ghost-muted"
                                aria-label="Remove queued message"
                                onClick={() => props.onRemove(entry.id)}
                              />
                            }
                          >
                            <Trash2Icon />
                          </TooltipTrigger>
                          <TooltipPopup side="top">Remove</TooltipPopup>
                        </Tooltip>
                        <Menu>
                          <MenuTrigger
                            render={
                              <Button
                                type="button"
                                size="icon-xs"
                                variant="ghost-muted"
                                aria-label="Queued message actions"
                              />
                            }
                          >
                            <EllipsisIcon />
                          </MenuTrigger>
                          <MenuPopup align="end">
                            <MenuItem
                              onClick={() => setEditing({ id: entry.id, prompt: entry.prompt })}
                            >
                              <PencilIcon />
                              Edit text
                            </MenuItem>
                          </MenuPopup>
                        </Menu>
                      </>
                    )}
                  </ComposerBanner.Actions>
                </ComposerBanner.Row>
              );
            })}
          </ComposerBanner.Children>
        </ComposerBanner.Scroll>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
