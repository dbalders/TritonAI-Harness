import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  ProjectNextStep,
  ProjectNextStepFeedbackKind,
  ProjectOverviewSnapshot,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

/**
 * Mounted once per physical project. The server owns the durable cache and dedupes generation;
 * dismiss and restore change what the live subscription shows.
 */
export function useProjectOverview({
  environmentId,
  projectId,
  connected,
  supported,
  feedbackSupported,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  connected: boolean;
  supported: boolean;
  /** The server can hide and restore individual suggestions. */
  feedbackSupported: boolean;
}) {
  const allowed = useAtomValue(
    serverEnvironment.ensureProjectOverview.permissionAtom(environmentId),
  );
  const query = useEnvironmentQuery(
    connected && supported
      ? serverEnvironment.projectOverview({ environmentId, input: { projectId } })
      : null,
  );
  const [saved, setSaved] = useState<ProjectOverviewSnapshot | null>(null);
  const [checking, setChecking] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const ensure = useAtomCommand(serverEnvironment.ensureProjectOverview, {
    label: "Update project next steps",
    reportFailure: false,
  });
  const sendDismiss = useAtomCommand(serverEnvironment.dismissProjectNextStep, {
    label: "Dismiss project next step",
    reportFailure: false,
  });
  const sendRestore = useAtomCommand(serverEnvironment.restoreProjectNextSteps, {
    label: "Restore project next steps",
    reportFailure: false,
  });
  const [lastQueryData, setLastQueryData] = useState(query.data);
  if (query.data !== lastQueryData) {
    setLastQueryData(query.data);
    if (query.data) setSaved(query.data);
  }
  const restore = async (stepId?: string) => {
    const result = await sendRestore({
      environmentId,
      input: stepId === undefined ? { projectId } : { projectId, stepId },
    });
    if (result._tag === "Success") {
      setRequestError(null);
    } else if (!isAtomCommandInterrupted(result)) {
      setRequestError(failureMessage(result, "Couldn't restore suggestions. Try again."));
    }
  };
  const dismiss = async (step: ProjectNextStep, kind: ProjectNextStepFeedbackKind) => {
    const result = await sendDismiss({
      environmentId,
      input: { projectId, stepId: step.id, kind },
    });
    if (result._tag !== "Success") {
      if (!isAtomCommandInterrupted(result)) {
        setRequestError(failureMessage(result, "Couldn't save that change. Try again."));
      }
      return;
    }
    setRequestError(null);
    toastManager.add({
      type: "success",
      title: kind === "done" ? "Marked as done" : "Suggestion hidden",
      description: "It won't be suggested again for this project.",
      actionProps: { children: "Undo", onClick: () => void restore(step.id) },
    });
  };
  const refresh = async (force = false) => {
    if (!connected || !supported || !allowed || inFlight.current) return;
    inFlight.current = true;
    setChecking(true);
    setRequestError(null);
    return await (async () => {
      try {
        const result = await ensure({ environmentId, input: { projectId, force } });
        if (result._tag !== "Success") setRequestError("Couldn't check next steps. Try again.");
      } catch {
        setRequestError("Couldn't check next steps. Try again.");
      }
    })().finally(async () => {
      inFlight.current = false;
      setChecking(false);
    });
  };
  useEffect(() => {
    void Promise.resolve().then(() => refresh());
  }, [refresh]);
  const snapshot = connected ? (query.data ?? saved) : saved;
  return {
    snapshot,
    checking,
    busy: checking || snapshot?.generation.state === "generating",
    error: requestError ?? query.error ?? snapshot?.generation.message ?? null,
    canRefresh: connected && supported && allowed,
    canGiveFeedback: connected && supported && allowed && feedbackSupported,
    refresh,
    dismiss,
    restore,
  };
}
export type ProjectOverviewView = ReturnType<typeof useProjectOverview>;
