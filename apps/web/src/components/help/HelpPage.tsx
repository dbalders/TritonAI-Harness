import { useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type HelpContext,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { InfoIcon, SendIcon } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { isElectron } from "../../env";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import {
  readEnvironmentScope,
  readPreparedConnection,
  useEnvironmentScope,
  usePreparedConnection,
} from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { HelpConversationLog } from "./HelpConversationLog";
import { HelpEnvironmentPanel } from "./HelpEnvironmentPanel";
import { HelpFeedbackForm } from "./HelpFeedbackForm";
import { captureHelpClientContext } from "./helpClientContext";
import {
  helpConversationFor,
  isHelpAuthorizationDenied,
  shouldSubmitHelpComposer,
  type HelpConversation,
} from "./helpConversation";

const QUICK_QUESTIONS = [
  "Why is my provider not responding?",
  "How do I change my model?",
  "How do I connect a plugin?",
] as const;

const LOADING_SNAPSHOT = "Loading the environment snapshot…";

// A request can survive navigation. Clear from any mounted session invalidates local reads too.
const clientReadRequests = new WeakMap<HelpConversation, object>();

/** Whether the prepared connection a session rendered for is still current and can read context. */
function hasCurrentReadAccess(
  environmentId: EnvironmentId | null,
  connection: PreparedConnection | null,
) {
  return (
    environmentId !== null &&
    connection !== null &&
    readPreparedConnection(environmentId) === connection &&
    readEnvironmentScope(environmentId, AuthDiagnosticsReadScope) &&
    readEnvironmentScope(environmentId, AuthOrchestrationReadScope)
  );
}

export function HelpPage() {
  const environmentId = usePrimaryEnvironmentId();
  const prepared = usePreparedConnection(environmentId);
  const connection = Option.getOrNull(prepared);
  const conversation = helpConversationFor(connection);
  return (
    <HelpSession
      key={conversation.id}
      environmentId={environmentId}
      connection={connection}
      conversation={conversation}
    />
  );
}

function HelpSession({
  environmentId,
  connection,
  conversation,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly connection: PreparedConnection | null;
  readonly conversation: HelpConversation;
}) {
  const snapshot = useSyncExternalStore(
    conversation.subscribe,
    conversation.getSnapshot,
    conversation.getSnapshot,
  );
  const environment = useEnvironment(environmentId);
  const connected = connection !== null && environment?.connection.phase === "connected";
  const canReadDiagnostics = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const canReadOrchestration = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const allowed = useAtomValue(serverEnvironment.askHelp.permissionAtom(environmentId));
  const canReadContext = connected && canReadDiagnostics && canReadOrchestration;
  const query = useEnvironmentQuery(
    canReadContext && environmentId !== null
      ? serverEnvironment.helpContext({ environmentId, input: {} })
      : null,
  );
  const askHelp = useAtomCommand(serverEnvironment.askHelp, {
    reportFailure: false,
    reportDefect: false,
  });
  const authorizationDenied = isHelpAuthorizationDenied(query.failure);
  const canViewContext = canReadContext && !authorizationDenied && !snapshot.diagnosticsInvalidated;
  // Read-only context outlives operation access, but stays local to this prepared connection.
  const [diagnosticContext, setDiagnosticContext] = useState<HelpContext | null>(null);
  const protectedAccess = canViewContext && allowed && !snapshot.accessDenied;
  useEffect(() => {
    if (!canReadDiagnostics || !canReadOrchestration || authorizationDenied) {
      // oxlint-disable-next-line react/set-state-in-effect -- Discard the completed external read when context access is revoked.
      setDiagnosticContext(null);
    }
    if (!canReadDiagnostics || !canReadOrchestration || !allowed || authorizationDenied) {
      clientReadRequests.delete(conversation);
      conversation.revokeAccess();
    }
  }, [allowed, authorizationDenied, canReadDiagnostics, canReadOrchestration, conversation]);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<HTMLElement>(null);
  const latestQuestionRef = useRef<HTMLElement>(null);
  // Sending disables the composer and removes Retry, which drops keyboard focus. Set when a
  // request starts from the conversation, so focus returns to the composer once it settles.
  const restoreComposerFocus = useRef(false);
  // A query family can still expose the previous connection's cached result while reloading.
  // Adopt only a freshly completed read for this prepared connection; never render query.data.
  const refreshBoundary = useRef<{
    readonly connection: PreparedConnection;
    readonly previous: typeof query.data;
    readonly canAsk: boolean;
  } | null>(null);
  useEffect(() => {
    if (!snapshot.diagnosticsInvalidated) return;
    // Reads started before an authoritative Ask denial cannot restore access.
    refreshBoundary.current = null;
    // oxlint-disable-next-line react/set-state-in-effect -- Discard the external read invalidated by the server.
    setDiagnosticContext(null);
  }, [snapshot.diagnosticsInvalidated]);
  const refresh = query.refresh;
  const contextBeforeRefresh = useEffectEvent(() => query.data);
  useEffect(() => {
    if (
      !canReadContext ||
      connection === null ||
      !hasCurrentReadAccess(environmentId, connection)
    ) {
      refreshBoundary.current = null;
      return;
    }
    refreshBoundary.current = { connection, previous: contextBeforeRefresh(), canAsk: allowed };
    refresh();
  }, [allowed, canReadContext, connection, environmentId, refresh]);
  useEffect(() => {
    if (
      canReadContext &&
      !authorizationDenied &&
      connection !== null &&
      hasCurrentReadAccess(environmentId, connection) &&
      refreshBoundary.current?.connection === connection &&
      query.isSuccess &&
      !query.isPending &&
      query.data !== null &&
      query.data !== refreshBoundary.current.previous
    ) {
      setDiagnosticContext(query.data);
      if (
        allowed &&
        refreshBoundary.current.canAsk &&
        environmentId !== null &&
        readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
      )
        conversation.setContext(query.data);
      else conversation.acceptDiagnosticsRead();
    }
  }, [
    allowed,
    authorizationDenied,
    canReadContext,
    connection,
    conversation,
    environmentId,
    query.data,
    query.isPending,
    query.isSuccess,
  ]);
  useLayoutEffect(() => {
    if (snapshot.messages.length === 0 && !snapshot.pendingQuestion && !snapshot.failedQuestion)
      return;
    // The page scrolls, not the transcript: put the newest question at the top, before paint,
    // so its answer reads from the start.
    latestQuestionRef.current?.scrollIntoView({ block: "start" });
  }, [snapshot.messages, snapshot.pendingQuestion, snapshot.failedQuestion]);

  const context = canViewContext
    ? ((protectedAccess ? snapshot.context : null) ?? diagnosticContext)
    : null;
  const messages = protectedAccess ? snapshot.messages : [];
  const composerDraft = protectedAccess ? snapshot.draft : "";
  const responseError = protectedAccess ? snapshot.error : null;
  const accessNotice =
    environmentId === null
      ? "Choose a connection in Settings > Connections to ask Help. You can still prepare feedback."
      : !connected
        ? "Connect to this environment to ask Help. Settings links and feedback remain available."
        : !canReadDiagnostics || !canReadOrchestration
          ? "This connection needs diagnostics:read and orchestration:read to load the snapshot, and orchestration:operate to ask Help. Settings links and feedback remain available."
          : !allowed && !authorizationDenied
            ? "This connection needs orchestration:operate to ask Help. The environment snapshot and feedback remain available."
            : authorizationDenied || snapshot.accessDenied
              ? "Help access was denied. Restore diagnostics:read, orchestration:read, and orchestration:operate, then refresh the snapshot. Settings links and feedback remain available."
              : query.error
                ? "The environment could not provide Help context. Refresh the snapshot or use the settings links."
                : context === null
                  ? LOADING_SNAPSHOT
                  : null;
  const pending = protectedAccess && snapshot.pendingQuestion !== null;
  const canSend = protectedAccess && context !== null && query.isSuccess && !query.error;
  const validDraft = snapshot.draft.trim().length > 0 && snapshot.draft.trim().length <= 8000;
  const send = () => {
    if (!canSend || environmentId === null) return;
    const isAuthorized = () =>
      hasCurrentReadAccess(environmentId, connection) &&
      readEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
    void conversation.send(async (history) => {
      const request = {};
      clientReadRequests.set(conversation, request);
      const isCurrent = () =>
        clientReadRequests.get(conversation) === request &&
        conversation.getSnapshot().pendingQuestion !== null &&
        !conversation.getSnapshot().accessDenied &&
        isAuthorized();
      const client = await captureHelpClientContext(isCurrent);
      if (client === null || !isCurrent()) throw new Error("Help request is no longer current");
      const result = await askHelp({ environmentId, input: { messages: history, client } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    }, isAuthorized);
  };
  const sendFromConversation = () => {
    const section = conversationRef.current;
    // Touch screens skip this: focusing would reopen the on-screen keyboard over the answer.
    restoreComposerFocus.current =
      section !== null &&
      section.contains(section.ownerDocument.activeElement) &&
      section.ownerDocument.defaultView?.matchMedia("(pointer: coarse)").matches !== true;
    send();
  };
  useEffect(() => {
    if (pending || !restoreComposerFocus.current) return;
    restoreComposerFocus.current = false;
    const composer = composerRef.current;
    if (composer === null || composer.disabled) return;
    // Reclaim only focus the disabled composer dropped, never focus the user moved elsewhere.
    const active = composer.ownerDocument.activeElement;
    if (active === null || active === composer.ownerDocument.body)
      composer.focus({ preventScroll: true });
  }, [pending]);
  const retry = useStableCallback(sendFromConversation);
  const chooseSuggestion = useStableCallback((question: string) => {
    conversation.setDraft(question);
    composerRef.current?.focus();
  });
  const refreshSnapshot = useStableCallback(() => {
    if (!canReadContext || connection === null || !hasCurrentReadAccess(environmentId, connection))
      return;
    refreshBoundary.current = { connection, previous: query.data, canAsk: allowed };
    query.refresh();
  });
  const submittedQuestion = protectedAccess
    ? (snapshot.pendingQuestion ?? snapshot.failedQuestion)
    : null;
  // Discard form text and opt-in before losing access can remove path sanitization.
  const feedbackSessionKey = `${canViewContext}:${allowed}:${snapshot.accessDenied}`;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <WorkspacePageHeader electron={isElectron}>
        <WorkspaceBreadcrumb ariaLabel="Help navigation">
          <WorkspaceBreadcrumbItem current>Help</WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer width="expanded">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1.5">
              <h1 className="text-xl font-semibold tracking-tight">Help</h1>
              <p className="text-sm leading-6 text-muted-foreground">
                Ask about TritonAI, check a connection, or prepare feedback.
              </p>
              <p className="text-xs leading-5 text-muted-foreground">
                {environment ? (
                  <>
                    For <span className="font-medium text-foreground">{environment.label}</span> ·
                    primary environment
                  </>
                ) : (
                  "No primary environment connected"
                )}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setFeedbackOpen((open) => !open)}
              aria-expanded={feedbackOpen}
              aria-controls="help-feedback"
            >
              {feedbackOpen ? "Hide feedback" : "Prepare feedback"}
            </Button>
          </div>
          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_19rem]">
            <div className="min-w-0 space-y-6">
              {feedbackOpen ? (
                <HelpFeedbackForm
                  key={feedbackSessionKey}
                  context={context}
                  conversation={
                    submittedQuestion
                      ? [...messages, { role: "user", content: submittedQuestion }]
                      : messages
                  }
                />
              ) : null}
              {/* Above phone widths the composer sticks to the bottom of the page while the
                  conversation scrolls. overflow-clip rounds its corners without becoming the
                  scroller it would stick to. */}
              <section
                ref={conversationRef}
                aria-labelledby="help-conversation-heading"
                className="min-w-0 overflow-clip rounded-xl border border-border/70"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5 sm:px-5">
                  <h2 id="help-conversation-heading" className="text-sm font-semibold">
                    Ask Help
                  </h2>
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    onClick={() => {
                      clientReadRequests.delete(conversation);
                      conversation.clear();
                    }}
                    disabled={messages.length === 0 && !submittedQuestion && !composerDraft}
                  >
                    Clear conversation
                  </Button>
                </div>
                <HelpConversationLog
                  messages={messages}
                  submittedQuestion={submittedQuestion}
                  pending={pending}
                  error={responseError}
                  retryLabel={
                    snapshot.draft.trim() === snapshot.failedQuestion
                      ? "Retry response"
                      : "Send edited question"
                  }
                  canRetry={canSend && !pending && validDraft}
                  onRetry={retry}
                  suggestions={QUICK_QUESTIONS}
                  canUseSuggestions={protectedAccess}
                  onSuggestion={chooseSuggestion}
                  latestQuestionRef={latestQuestionRef}
                />
                <form
                  className="flex flex-col gap-2.5 border-t border-border/60 bg-background p-4 surface-grain sm:sticky sm:bottom-0 sm:px-5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    sendFromConversation();
                  }}
                >
                  {accessNotice === LOADING_SNAPSHOT ? (
                    <p
                      id="help-access-notice"
                      role="status"
                      className="flex items-center gap-2 text-xs leading-5 text-muted-foreground"
                    >
                      <Spinner size="xs" aria-hidden="true" />
                      {accessNotice}
                    </p>
                  ) : accessNotice ? (
                    <Alert
                      id="help-access-notice"
                      role="status"
                      variant="info"
                      controlAlignment="first-line"
                    >
                      <InfoIcon aria-hidden="true" />
                      <AlertDescription>{accessNotice}</AlertDescription>
                    </Alert>
                  ) : null}
                  <label htmlFor="help-question" className="sr-only">
                    Your question
                  </label>
                  <Textarea
                    id="help-question"
                    ref={composerRef}
                    value={composerDraft}
                    maxLength={8000}
                    disabled={pending || !protectedAccess}
                    onChange={(event) => conversation.setDraft(event.target.value)}
                    placeholder="What can we help with?"
                    aria-describedby={`help-composer-note${accessNotice ? " help-access-notice" : ""}`}
                    onKeyDown={(event) => {
                      if (
                        shouldSubmitHelpComposer({
                          key: event.key,
                          shiftKey: event.shiftKey,
                          isComposing: event.nativeEvent.isComposing,
                          keyCode: event.nativeEvent.keyCode,
                        })
                      ) {
                        event.preventDefault();
                        sendFromConversation();
                      }
                    }}
                  />
                  <div className="flex items-center justify-between gap-4">
                    <p id="help-composer-note" className="text-xs leading-5 text-muted-foreground">
                      Sends a fresh environment snapshot and your app preferences to your text
                      generation model. History stays until you reload or restart.
                    </p>
                    <Button type="submit" size="sm" disabled={!canSend || pending || !validDraft}>
                      <SendIcon aria-hidden="true" />
                      Send
                    </Button>
                  </div>
                </form>
              </section>
            </div>
            <HelpEnvironmentPanel
              context={context}
              pending={query.isPending}
              canRefresh={canReadContext}
              notice={
                query.error
                  ? "Could not refresh the environment snapshot. Try Refresh or open Diagnostics."
                  : context === null
                    ? canViewContext
                      ? LOADING_SNAPSHOT
                      : accessNotice
                    : null
              }
              onRefresh={refreshSnapshot}
            />
          </div>
        </WorkspacePageContainer>
      </div>
    </SidebarInset>
  );
}
