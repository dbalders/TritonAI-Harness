import type { HelpMessage } from "@t3tools/contracts";
import { CircleAlertIcon, CircleHelpIcon, RotateCcwIcon } from "lucide-react";
import type { Ref } from "react";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { HelpMarkdown } from "./HelpMarkdown";

/**
 * The Help transcript. Questions use the right-aligned bubble of a user turn in a thread, and
 * answers run full width under the sidebar's Help mark, so who is speaking is clear at a glance
 * and long answers keep a readable line.
 */
export function HelpConversationLog({
  messages,
  submittedQuestion,
  pending,
  error,
  retryLabel,
  canRetry,
  onRetry,
  suggestions,
  canUseSuggestions,
  onSuggestion,
  latestQuestionRef,
}: {
  readonly messages: readonly (HelpMessage & { readonly id: number })[];
  /** A question that is waiting for an answer or failed to get one. */
  readonly submittedQuestion: string | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly retryLabel: string;
  readonly canRetry: boolean;
  readonly onRetry: () => void;
  readonly suggestions: readonly string[];
  readonly canUseSuggestions: boolean;
  readonly onSuggestion: (question: string) => void;
  /** Attached to the newest question, which the page scrolls to so answers read from the start. */
  readonly latestQuestionRef: Ref<HTMLElement>;
}) {
  const latestAnsweredQuestionId =
    submittedQuestion === null
      ? messages.findLast((message) => message.role === "user")?.id
      : undefined;
  return (
    <div
      role="log"
      aria-label="Help conversation"
      aria-live="polite"
      aria-relevant="additions text"
      className="space-y-4 px-4 py-5 sm:px-5"
    >
      {messages.length === 0 && submittedQuestion === null ? (
        <div className="space-y-3">
          <p className="text-sm leading-6 text-muted-foreground">
            Ask about settings, providers, plugins, or something that isn't working. Suggestions
            fill in your question; nothing runs until you send.
          </p>
          {/* One row on desktop, where tight columns wrap text inside each chip instead. */}
          <ul
            aria-label="Suggested questions"
            className="flex flex-wrap items-center gap-2 lg:flex-nowrap"
          >
            {suggestions.map((question) => (
              <li key={question} className="max-w-full min-w-0">
                <Button
                  variant="outline"
                  size="sm-multiline"
                  disabled={!canUseSuggestions}
                  onClick={() => onSuggestion(question)}
                >
                  {question}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {messages.map((message) =>
        message.role === "user" ? (
          <HelpQuestion
            key={message.id}
            content={message.content}
            ref={message.id === latestAnsweredQuestionId ? latestQuestionRef : undefined}
          />
        ) : (
          <article key={message.id} className="max-w-3xl space-y-2">
            <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <HelpMark />
              Help
            </h3>
            <HelpMarkdown content={message.content} />
          </article>
        ),
      )}
      {submittedQuestion !== null ? (
        <HelpQuestion content={submittedQuestion} ref={latestQuestionRef} />
      ) : null}
      {pending ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <HelpMark />
          Help is preparing a response…
          <Spinner size="sm" tone="muted" aria-hidden="true" />
        </p>
      ) : null}
      {error !== null ? (
        <Alert variant="error" controlAlignment="first-line">
          <CircleAlertIcon aria-hidden="true" />
          <AlertDescription>
            <p>{error}</p>
            <div>
              <Button size="xs" variant="outline" onClick={onRetry} disabled={!canRetry}>
                <RotateCcwIcon aria-hidden="true" />
                {retryLabel}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

/** A question bubble. The wider gap above it groups each question with the answer below. */
function HelpQuestion({
  content,
  ref,
}: {
  readonly content: string;
  readonly ref?: Ref<HTMLElement> | undefined;
}) {
  return (
    <article ref={ref} className="flex scroll-mt-6 flex-col items-end not-first:mt-8">
      <h3 className="sr-only select-none">You</h3>
      <p className="max-w-[80%] rounded-2xl bg-message px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap text-message-foreground wrap-anywhere">
        {content}
      </p>
    </article>
  );
}

function HelpMark() {
  return <CircleHelpIcon aria-hidden="true" className="size-4 shrink-0 text-primary" />;
}
