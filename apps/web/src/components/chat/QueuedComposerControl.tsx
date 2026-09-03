import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CornerUpRightIcon,
  ImageIcon,
  ListOrderedIcon,
  LoaderCircleIcon,
  PaperclipIcon,
  PencilIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useId, useState } from "react";

import type { QueuedComposerEntry } from "../../composerQueueStore";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";

export function QueuedComposerControl(props: {
  readonly entries: readonly QueuedComposerEntry[];
  readonly canSteer: boolean;
  readonly onSteer: (entryId: string) => void;
  readonly onRemove: (entryId: string) => void;
  readonly onMove: (entryId: string, offset: -1 | 1) => void;
  readonly onEdit: (entryId: string, prompt: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState<{ readonly id: string; readonly prompt: string } | null>(
    null,
  );
  const listId = useId();

  if (props.entries.length === 0) return null;

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        role="region"
        aria-label={`${props.entries.length} queued message${props.entries.length === 1 ? "" : "s"}`}
        aria-live="polite"
        data-chat-composer-queued-messages="true"
      >
        <ComposerBanner.Row
          render={<button type="button" />}
          aria-label={expanded ? "Collapse queued messages" : "Expand queued messages"}
          aria-expanded={expanded}
          aria-controls={listId}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => setExpanded((value) => !value)}
        >
          <ComposerBanner.Icon>
            <ListOrderedIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="text-muted-foreground">Queued</ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerBanner.Count>{props.entries.length}</ComposerBanner.Count>
            <ComposerBanner.ToggleIcon expanded={expanded} />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        <ComposerBanner.Scroll className={cn("max-h-40", !expanded && "hidden")}>
          <ComposerBanner.Children render={<ol />} id={listId}>
            {props.entries.map((entry, index) => {
              const busy = entry.status === "dispatching";
              const failed = entry.status === "failed";
              const isEditing = editing?.id === entry.id;
              const attachmentCount = entry.images.length + entry.files.length;
              return (
                <ComposerBanner.Row
                  render={<li />}
                  key={entry.id}
                  className={cn("rounded-sm", failed && "bg-destructive/5")}
                >
                  <ComposerBanner.Icon aria-hidden={false}>
                    {busy ? (
                      <LoaderCircleIcon
                        className="animate-spin"
                        aria-label="Sending queued message"
                      />
                    ) : failed ? (
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
                    ) : null}
                  </ComposerBanner.Icon>
                  <ComposerBanner.Content className="text-foreground/80">
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
                                size="icon-xs"
                                variant="ghost-muted"
                                disabled={busy || index === 0}
                                aria-label="Move queued message up"
                                onClick={() => props.onMove(entry.id, -1)}
                              />
                            }
                          >
                            <ArrowUpIcon />
                          </TooltipTrigger>
                          <TooltipPopup side="top">Move up</TooltipPopup>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                type="button"
                                size="icon-xs"
                                variant="ghost-muted"
                                disabled={busy || index === props.entries.length - 1}
                                aria-label="Move queued message down"
                                onClick={() => props.onMove(entry.id, 1)}
                              />
                            }
                          >
                            <ArrowDownIcon />
                          </TooltipTrigger>
                          <TooltipPopup side="top">Move down</TooltipPopup>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                type="button"
                                size="icon-xs"
                                variant="ghost-muted"
                                disabled={busy}
                                aria-label="Edit queued message"
                                onClick={() => setEditing({ id: entry.id, prompt: entry.prompt })}
                              />
                            }
                          >
                            <PencilIcon />
                          </TooltipTrigger>
                          <TooltipPopup side="top">Edit text</TooltipPopup>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                type="button"
                                size="icon-xs"
                                variant="ghost-muted"
                                disabled={!props.canSteer || busy}
                                aria-label={
                                  failed
                                    ? "Retry queued message as steer"
                                    : "Steer queued message now"
                                }
                                onClick={() => props.onSteer(entry.id)}
                              />
                            }
                          >
                            <CornerUpRightIcon />
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
                                disabled={busy}
                                aria-label="Remove queued message"
                                onClick={() => props.onRemove(entry.id)}
                              />
                            }
                          >
                            <XIcon />
                          </TooltipTrigger>
                          <TooltipPopup side="top">Remove</TooltipPopup>
                        </Tooltip>
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
