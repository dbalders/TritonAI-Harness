import type { HelpAskResult, HelpContext, HelpMessage } from "@t3tools/contracts";

export interface HelpConversationSnapshot {
  readonly messages: readonly (HelpMessage & { readonly id: number })[];
  readonly draft: string;
  readonly pendingQuestion: string | null;
  readonly failedQuestion: string | null;
  readonly error: string | null;
  readonly context: HelpContext | null;
  readonly accessDenied: boolean;
  readonly diagnosticsInvalidated: boolean;
}

const INITIAL_SNAPSHOT: HelpConversationSnapshot = {
  messages: [],
  draft: "",
  pendingQuestion: null,
  failedQuestion: null,
  error: null,
  context: null,
  accessDenied: false,
  diagnosticsInvalidated: false,
};

export function isHelpAuthorizationDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "EnvironmentAuthorizationError"
  );
}

const HELP_ERRORS: Readonly<Record<string, string>> = {
  unavailable: "Help is unavailable. Choose a text generation model in Settings > General.",
  unsupported:
    "This model does not support Help. Choose another text generation model in Settings > General.",
  busy: "Help is busy. Wait for the current request to finish, then try again.",
  timeout: "Help took too long to respond. Your question is kept; you can try again.",
  generation_failed: "Help could not generate an answer. Check Providers, then try again.",
  invalid_request: "Keep your question under 8,000 characters, then try again.",
};

/** Never surface a transport exception, provider stderr, or an unrecognized server message. */
export function helpFailureMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "HelpError" &&
    "code" in error &&
    typeof error.code === "string" &&
    Object.hasOwn(HELP_ERRORS, error.code)
  ) {
    return HELP_ERRORS[error.code]!;
  }
  return "Help could not respond. Your question is kept. Check Providers or Connections, then try again.";
}

/** Nine complete exchanges plus the new question fit the bounded server input. */
function helpRequestMessages(
  history: readonly HelpMessage[],
  question: string,
): readonly HelpMessage[] {
  return [
    ...history.slice(-18).map((message) => ({
      role: message.role,
      content: message.content.slice(0, 8_000),
    })),
    { role: "user", content: question },
  ];
}

let nextConversationId = 0;

export function createHelpConversation() {
  let snapshot = INITIAL_SNAPSHOT;
  let generation = 0;
  let nextMessageId = 0;
  const listeners = new Set<() => void>();
  const update = (next: HelpConversationSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const revokeAccess = (invalidateDiagnostics = false) => {
    generation += 1;
    update({
      ...INITIAL_SNAPSHOT,
      accessDenied: true,
      diagnosticsInvalidated: snapshot.diagnosticsInvalidated || invalidateDiagnostics,
    });
  };
  return {
    id: ++nextConversationId,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setDraft: (draft: string) => {
      if (!snapshot.accessDenied && snapshot.draft !== draft) update({ ...snapshot, draft });
    },
    setContext: (context: HelpContext) => {
      if (snapshot.context !== context || snapshot.accessDenied)
        update({ ...snapshot, context, accessDenied: false, diagnosticsInvalidated: false });
    },
    acceptDiagnosticsRead: () => {
      if (snapshot.diagnosticsInvalidated) update({ ...snapshot, diagnosticsInvalidated: false });
    },
    revokeAccess,
    clear: () => {
      generation += 1;
      update({
        ...INITIAL_SNAPSHOT,
        context: snapshot.context,
        accessDenied: snapshot.accessDenied,
        diagnosticsInvalidated: snapshot.diagnosticsInvalidated,
      });
    },
    async send(
      ask: (messages: readonly HelpMessage[]) => Promise<HelpAskResult>,
      isAuthorized: () => boolean = () => true,
    ): Promise<void> {
      if (!isAuthorized()) {
        revokeAccess();
        return;
      }
      if (snapshot.accessDenied) return;
      const question = snapshot.draft.trim();
      if (snapshot.pendingQuestion !== null || question.length === 0 || question.length > 8_000)
        return;
      const requestGeneration = ++generation;
      const history = snapshot.messages;
      const submittedDraft = snapshot.draft;
      update({ ...snapshot, pendingQuestion: question, failedQuestion: null, error: null });
      try {
        const result = await ask(helpRequestMessages(history, question));
        if (generation !== requestGeneration) return;
        if (!isAuthorized()) {
          revokeAccess();
          return;
        }
        update({
          ...snapshot,
          messages: [
            ...history,
            { id: ++nextMessageId, role: "user", content: question },
            { id: ++nextMessageId, role: "assistant", content: result.answer },
          ],
          draft: snapshot.draft === submittedDraft ? "" : snapshot.draft,
          pendingQuestion: null,
          context: result.context,
        });
      } catch (error) {
        if (isHelpAuthorizationDenied(error)) {
          // A server denial can arrive before cached grants change. Require a
          // fresh read even if Clear already invalidated the question's result.
          revokeAccess(true);
          return;
        }
        if (generation !== requestGeneration) return;
        if (!isAuthorized()) {
          revokeAccess();
          return;
        }
        update({
          ...snapshot,
          pendingQuestion: null,
          failedQuestion: question,
          error: helpFailureMessage(error),
        });
      }
    },
  };
}

export type HelpConversation = ReturnType<typeof createHelpConversation>;

// Object identity deliberately follows the prepared/authenticated transport, never just an
// environment ID. Weak keys retain no serialized credentials and reset on a new connection.
const conversations = new WeakMap<object, HelpConversation>();
const disconnectedConversation = createHelpConversation();

export function helpConversationFor(connection: object | null): HelpConversation {
  if (connection === null) return disconnectedConversation;
  let conversation = conversations.get(connection);
  if (!conversation) {
    conversation = createHelpConversation();
    conversations.set(connection, conversation);
  }
  return conversation;
}

export function shouldSubmitHelpComposer(event: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
  readonly keyCode?: number;
}): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}
