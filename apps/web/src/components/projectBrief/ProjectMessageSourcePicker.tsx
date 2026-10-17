import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useMemo, useState } from "react";
import { useThreadShellsForProjectRefs } from "../../state/entities";
import { useEnvironmentThread } from "../../state/threads";

export function ProjectMessageSourcePicker({
  environmentId,
  projectId,
  disabled,
  onSelect,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  disabled: boolean;
  onSelect: (threadId: string, messageId: string) => void;
}) {
  const refs = useMemo(
    () => [scopeProjectRef(environmentId, projectId)],
    [environmentId, projectId],
  );
  const threads = useThreadShellsForProjectRefs(refs);
  const [selectedThread, setSelectedThread] = useState("");
  const [selectedMessage, setSelectedMessage] = useState("");
  const validThread = threads.some((thread) => thread.id === selectedThread);
  const detail = useEnvironmentThread(
    environmentId,
    validThread ? ThreadId.make(selectedThread) : null,
  );
  const projection = Option.getOrNull(detail.data);
  const messages =
    projection?.thread.projectId === projectId &&
    detail.status === "live" &&
    Option.isNone(detail.error)
      ? projection.messages.filter(
          (message) => !message.streaming && message.role !== "system" && message.text.trim(),
        )
      : [];
  const message = messages.find((item) => item.id === selectedMessage);
  return (
    <div className="space-y-3">
      <label className="block space-y-1.5 text-xs font-medium">
        <span>Project thread</span>
        <select
          aria-label="Source thread"
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          disabled={disabled}
          value={validThread ? selectedThread : ""}
          onChange={(event) => {
            setSelectedThread(event.target.value);
            setSelectedMessage("");
            onSelect(event.target.value, "");
          }}
        >
          <option value="">Choose a thread…</option>
          {threads.map((thread) => (
            <option key={thread.id} value={thread.id}>
              {thread.title}
            </option>
          ))}
        </select>
      </label>
      {threads.length === 0 ? (
        <p className="text-xs text-muted-foreground">There are no threads in this project yet.</p>
      ) : null}
      {validThread ? (
        <>
          {Option.isSome(detail.error) ? (
            <p role="alert" className="text-xs text-destructive">
              {detail.error.value}
            </p>
          ) : detail.status !== "live" ? (
            <p role="status" className="text-xs text-muted-foreground">
              Loading messages…
            </p>
          ) : (
            <label className="block space-y-1.5 text-xs font-medium">
              <span>Message</span>
              <select
                aria-label="Source message"
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                disabled={disabled}
                value={message?.id ?? ""}
                onChange={(event) => {
                  setSelectedMessage(event.target.value);
                  onSelect(selectedThread, event.target.value);
                }}
              >
                <option value="">Choose a message…</option>
                {messages.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.role === "user" ? "You" : "Agent"}:{" "}
                    {item.text.replace(/\s+/g, " ").slice(0, 100)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {message ? (
            <p className="max-h-52 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border p-3 text-xs leading-5 text-muted-foreground">
              {message.text}
            </p>
          ) : null}
          {detail.history.hasMoreHistory ? (
            <p className="text-xs leading-5 text-muted-foreground">
              Showing recent messages. To use an older message, copy its text into a pasted excerpt.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
