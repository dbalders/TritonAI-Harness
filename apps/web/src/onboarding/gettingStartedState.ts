import {
  useClientSettings,
  persistClientSettingsUpdate,
  getClientSettings,
} from "../hooks/useSettings";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { reduceGettingStarted, type GettingStartedEvent } from "./gettingStarted.logic";
import { toastManager } from "../components/ui/toast";

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
  try {
    await persistClientSettingsUpdate((settings) => {
      if (!settings.experimentalGuidedTourEnabled) return settings;
      const gettingStarted = reduceGettingStarted(settings.gettingStarted, event);
      return gettingStarted === settings.gettingStarted
        ? settings
        : { ...settings, gettingStarted };
    });
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
