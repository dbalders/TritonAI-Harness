import {
  useClientSettings,
  persistClientSettingsUpdate,
  getClientSettings,
} from "../hooks/useSettings";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  GettingStartedAnalyticsInput,
  GettingStartedChapterId,
  GettingStartedProgress,
  ThreadId,
} from "@t3tools/contracts";
import {
  GETTING_STARTED_CHAPTERS,
  gettingStartedAnalyticsEvents,
  reduceGettingStarted,
  type GettingStartedEvent,
} from "./gettingStarted.logic";
import { toastManager } from "../components/ui/toast";
import { helpConversationFor } from "../components/help/helpConversation";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { readPreparedConnection } from "../state/session";

let preparationRevision = 0;

export function getGettingStartedPreparationRevision(): number {
  return preparationRevision;
}

export function cancelGettingStartedPreparation(): void {
  preparationRevision += 1;
}

export function useGettingStartedEnabled(): boolean {
  return useClientSettings((settings) => settings.experimentalGuidedTourEnabled);
}

export function useGettingStarted() {
  return useClientSettings((settings) => settings.gettingStarted);
}

export function openGettingStarted(environmentId: EnvironmentId): Promise<boolean> {
  return updateGettingStarted({ type: "start", environmentId, at: new Date().toISOString() });
}

export async function updateGettingStarted(event: GettingStartedEvent): Promise<boolean> {
  if (!getClientSettings().experimentalGuidedTourEnabled) return false;
  // Cancellation is user intent, so it takes effect before a slow settings save.
  const current = getClientSettings().gettingStarted;
  if (
    (event.generation === undefined || event.generation === current.generation) &&
    (event.fromChapter === undefined || event.fromChapter === current.activeChapter) &&
    (["start", "restart", "select", "pause", "close", "next", "later"].includes(event.type) ||
      (event.type === "acknowledge" && event.continue !== undefined))
  ) {
    preparationRevision += 1;
  }
  // Assigned inside the update callback, so declare the type without letting TS narrow it to null.
  let change = null as { before: GettingStartedProgress; after: GettingStartedProgress } | null;
  try {
    await persistClientSettingsUpdate((settings) => {
      if (!settings.experimentalGuidedTourEnabled) return settings;
      const gettingStarted = reduceGettingStarted(settings.gettingStarted, event);
      change = { before: settings.gettingStarted, after: gettingStarted };
      return gettingStarted === settings.gettingStarted
        ? settings
        : { ...settings, gettingStarted };
    });
    if (change) {
      const { before, after } = change;
      if (after.environmentId !== null) {
        for (const input of gettingStartedAnalyticsEvents(before, after)) {
          recordGettingStartedUsage(after.environmentId, input);
        }
      }
    }
    return true;
  } catch {
    toastManager.add({
      type: "error",
      title: "Could not save your guide progress",
      description: "You can keep working. Try opening Getting started again.",
    });
    return false;
  }
}

export function recordGettingStartedSubmission(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  messageId: string;
  generation: number;
}) {
  void updateGettingStarted({ type: "submitted", ...input });
}

/** Best effort; usage reporting never interrupts the guide. */
function recordGettingStartedUsage(
  environmentId: EnvironmentId,
  input: GettingStartedAnalyticsInput,
): void {
  void runAtomCommand(
    appAtomRegistry,
    serverEnvironment.recordGettingStarted,
    { environmentId, input },
    { label: "Record getting started usage", reportFailure: false, reportDefect: false },
  );
}

/** Start a Help question about the current chapter. The caller opens the Help page. */
export function prepareGettingStartedHelp(
  environmentId: EnvironmentId,
  chapter: GettingStartedChapterId,
): void {
  const title = GETTING_STARTED_CHAPTERS.find((item) => item.id === chapter)?.title ?? chapter;
  const conversation = helpConversationFor(readPreparedConnection(environmentId));
  if (conversation.getSnapshot().draft.trim() === "") {
    conversation.setDraft(
      `I'm on the "${title}" chapter of Getting started and I'm stuck. Here's what happened: `,
    );
  }
  recordGettingStartedUsage(environmentId, { event: "help-opened", chapter });
}
