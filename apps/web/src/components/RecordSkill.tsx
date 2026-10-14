import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_SERVER_SETTINGS,
  type DesktopBridge,
  type DesktopSkillRecordingStopResult,
  type EnvironmentId,
  type ProjectId,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { create } from "zustand";

import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useScratchProject } from "../hooks/useScratchProject";
import { newThreadId } from "../lib/utils";
import { resolveDefaultProviderModelSelection } from "../providerInstances";
import { buildRecordSkillPrompt, formatRecordedSteps } from "../recordSkill";
import { readThread, useProjects, waitForThreadShell } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { EMPTY_SERVER_PROVIDERS, environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { toastManager } from "./ui/toast";

type RecordSkillBridge = Required<
  Pick<DesktopBridge, "startSkillRecording" | "stopSkillRecording" | "cancelSkillRecording">
> &
  Pick<DesktopBridge, "requestSkillRecordingPermission" | "onSkillRecordingControl">;

/** The desktop bridge when this shell can record, otherwise null. */
export function readRecordSkillBridge(): RecordSkillBridge | null {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (!bridge?.startSkillRecording || !bridge.stopSkillRecording || !bridge.cancelSkillRecording) {
    return null;
  }
  return bridge as RecordSkillBridge;
}

/** Where a recording is sent when it stops: the conversation it started in, or a new one. */
export type RecordSkillOrigin =
  | { readonly kind: "thread"; readonly threadRef: ScopedThreadRef }
  | { readonly kind: "project"; readonly projectRef: ScopedProjectRef };

// The recording this window started, if any; at most one runs at a time.
const useActiveRecording = create<{
  sessionId: string | null;
  starting: boolean;
  origin: RecordSkillOrigin | null;
}>(() => ({ sessionId: null, starting: false, origin: null }));

// Stopped recordings waiting for their conversation's composer to send them, oldest first.
const usePendingRecordedSkills = create<{
  byTargetKey: Readonly<Record<string, ReadonlyArray<string>>>;
}>(() => ({ byTargetKey: {} }));

function queueRecordedSkill(targetKey: string, prompt: string) {
  usePendingRecordedSkills.setState(({ byTargetKey }) => ({
    byTargetKey: { ...byTargetKey, [targetKey]: [...(byTargetKey[targetKey] ?? []), prompt] },
  }));
}

/** The next recording waiting to be sent from the composer with this key, if any. */
export function usePendingRecordedSkillPrompt(targetKey: string): string | null {
  return usePendingRecordedSkills((state) => state.byTargetKey[targetKey]?.[0] ?? null);
}

/** Claims the next waiting recording for this composer, so each is sent once. */
export function takePendingRecordedSkillPrompt(targetKey: string): string | null {
  const [prompt, ...rest] = usePendingRecordedSkills.getState().byTargetKey[targetKey] ?? [];
  if (prompt === undefined) return null;
  usePendingRecordedSkills.setState(({ byTargetKey }) => {
    const { [targetKey]: _claimed, ...others } = byTargetKey;
    return { byTargetKey: rest.length ? { ...others, [targetKey]: rest } : others };
  });
  return prompt;
}

/**
 * Starts recording from a conversation's composer, the command palette, or
 * Settings. Stop on the floating recording bar sends the recording to
 * `origin`, or to a new conversation when there is none.
 */
export async function recordSkill(origin: RecordSkillOrigin | null = null) {
  const bridge = readRecordSkillBridge();
  const state = useActiveRecording.getState();
  if (!bridge || state.starting) return;
  if (state.sessionId) {
    toastManager.add({
      type: "info",
      title: "Already recording",
      description: "Select Stop on the recording bar when you're done.",
    });
    return;
  }
  useActiveRecording.setState({ starting: true });
  const result = await bridge
    .startSkillRecording()
    .catch(() => ({ status: "unavailable" as const }));
  useActiveRecording.setState({
    starting: false,
    sessionId: result.status === "recording" ? result.sessionId : null,
    origin: result.status === "recording" ? origin : null,
  });
  switch (result.status) {
    case "recording":
      toastManager.add({
        type: "info",
        title: "Recording",
        description:
          "Switch to the app and do the task once. Select Stop on the recording bar when you're done.",
      });
      return;
    case "permission-required":
      toastManager.add({
        type: "warning",
        title: "Harness needs Accessibility access to record other apps",
        description: "Allow access, then record the skill again.",
        actionProps: {
          children: "Allow access",
          onClick: () => void bridge.requestSkillRecordingPermission?.(),
        },
      });
      return;
    case "busy":
      toastManager.add({
        type: "info",
        title: "Already recording",
        description: "Another window is recording. Stop it from the recording bar first.",
      });
      return;
    case "unavailable":
      toastManager.add({ type: "error", title: "Harness couldn't start recording." });
      return;
  }
}

/** Hands a recording to the conversation that will send it. */
function useDeliverRecordedSkill() {
  const navigate = useNavigate();
  const { openScratchProject, scratchWorkspaceRootFor } = useScratchProject();
  const { activeThread, activeDraftThread } = useHandleNewThread();
  const projects = useProjects();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });

  const send = useCallback(
    async (threadRef: ScopedThreadRef, prompt: string) => {
      queueRecordedSkill(scopedThreadKey(threadRef), prompt);
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [navigate],
  );

  // An existing conversation keeps the recording while it is still there.
  const sendToThread = useCallback(
    async (threadRef: ScopedThreadRef, prompt: string): Promise<boolean> => {
      if (!readThread(threadRef)) return false;
      await send(threadRef, prompt);
      return true;
    },
    [send],
  );

  const sendToNewThread = useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId | null;
      readonly title: string;
      readonly prompt: string;
    }): Promise<string | null> => {
      // Prefer the project the recording started in, then "No project", then
      // the conversation the user is in; never a silent pick.
      const currentProjectId =
        input.projectId ?? activeThread?.projectId ?? activeDraftThread?.projectId ?? null;
      const findProject = (projectId: ProjectId | null) =>
        projects.find(
          (entry) => entry.environmentId === input.environmentId && entry.id === projectId,
        ) ?? null;
      const project =
        (input.projectId ? findProject(input.projectId) : null) ??
        (scratchWorkspaceRootFor(input.environmentId) !== null
          ? await openScratchProject(input.environmentId)
          : findProject(currentProjectId));
      if (!project) {
        return scratchWorkspaceRootFor(input.environmentId) !== null
          ? "Harness couldn't open a place for the new conversation."
          : "This computer doesn't allow conversations without a project. Open a conversation in a project, then record the skill again.";
      }
      const serverConfig = serverConfigs.get(input.environmentId);
      const projectSettings = resolveProjectSettings(
        serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
        project.id,
        project,
      ).settings;
      const drafts = useComposerDraftStore.getState();
      // The same choice a new thread here would start with.
      const modelSelection = resolveDefaultProviderModelSelection(
        serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS,
        projectSettings.defaultModelSelection ??
          (drafts.stickyActiveProvider
            ? (drafts.stickyModelSelectionByProvider[drafts.stickyActiveProvider] ?? null)
            : null),
      );
      if (!modelSelection) return "No provider is ready. Set one up in Settings → Providers.";

      const threadId = newThreadId();
      const created = await createThread({
        environmentId: input.environmentId,
        input: {
          threadId,
          projectId: project.id,
          title: input.title,
          modelSelection,
          runtimeMode: projectSettings.defaultRuntimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: new Date().toISOString(),
        },
      });
      if (created._tag === "Failure") return "Harness couldn't start the conversation.";

      const threadRef = scopeThreadRef(input.environmentId, threadId);
      // The route treats a thread it hasn't received yet as missing and leaves.
      const arrived = await waitForThreadShell(threadRef).then(
        () => true,
        () => false,
      );
      if (!arrived) {
        useComposerDraftStore.getState().setPrompt(threadRef, input.prompt);
        return `Harness created the conversation "${input.title}" with your recording, but couldn't open it. Find it in the sidebar and send it from there.`;
      }
      await send(threadRef, input.prompt);
      return null;
    },
    [
      activeDraftThread?.projectId,
      activeThread?.projectId,
      createThread,
      openScratchProject,
      projects,
      scratchWorkspaceRootFor,
      send,
      serverConfigs,
    ],
  );

  return { sendToThread, sendToNewThread };
}

/**
 * Mounted once for the whole app. When Stop is selected on the recording bar,
 * sends the recording to the conversation it started in, or a new one.
 */
export function RecordSkillHost() {
  const [bridge] = useState(readRecordSkillBridge);
  return bridge ? <RecordSkillFlow bridge={bridge} /> : null;
}

function RecordSkillFlow({ bridge }: { bridge: RecordSkillBridge }) {
  const environmentId = usePrimaryEnvironmentId();
  const deliver = useDeliverRecordedSkill();

  // A page that goes away mid-recording takes its recording with it.
  useEffect(
    () => () => {
      const { sessionId } = useActiveRecording.getState();
      useActiveRecording.setState({ sessionId: null, origin: null });
      if (sessionId) void bridge.cancelSkillRecording(sessionId);
    },
    [bridge],
  );

  const open = async (
    result: Extract<DesktopSkillRecordingStopResult, { status: "stopped" }>,
    origin: RecordSkillOrigin | null,
  ) => {
    if (result.steps.length === 0) {
      toastManager.add({
        type: "info",
        title: "Nothing was recorded",
        description: "After you start, switch to another app and do the task there.",
      });
      return;
    }
    const prompt = buildRecordSkillPrompt({
      durationMs: result.durationMs,
      limitReached: result.limitReached,
      steps: formatRecordedSteps(result.steps),
    });
    if (origin?.kind === "thread") {
      const sent = await deliver.sendToThread(origin.threadRef, prompt).catch(() => false);
      if (sent) return;
    }
    // A conversation that can't take it falls back to a new one on the same server and project.
    const originThread = origin?.kind === "thread" ? readThread(origin.threadRef) : null;
    const projectRef =
      origin?.kind === "project"
        ? origin.projectRef
        : origin?.kind === "thread" && originThread
          ? { environmentId: origin.threadRef.environmentId, projectId: originThread.projectId }
          : null;
    const target =
      origin?.kind === "thread"
        ? origin.threadRef.environmentId
        : (projectRef?.environmentId ?? environmentId);
    const failure = target
      ? await deliver
          .sendToNewThread({
            environmentId: target,
            projectId: projectRef?.projectId ?? null,
            title: "Record a skill",
            prompt,
          })
          .catch(() => "Harness couldn't start the conversation.")
      : "Harness isn't connected.";
    if (failure) {
      // The capture is gone from the desktop app by now, so this copy is the
      // user's way to keep it.
      toastManager.add({
        type: "error",
        title: "Recording not sent",
        description: `${failure} Copy the recording to paste it into a conversation yourself.`,
        actionProps: {
          children: "Copy recording",
          onClick: () =>
            void navigator.clipboard.writeText(prompt).then(
              () => toastManager.add({ type: "success", title: "Recording copied" }),
              () => toastManager.add({ type: "error", title: "Couldn't copy the recording" }),
            ),
        },
      });
    }
  };

  // Stop and Discard on the floating bar arrive here; Discard already happened.
  const handleControl = useEffectEvent((sessionId: string, action: "stop" | "discard") => {
    const { sessionId: activeSessionId, origin } = useActiveRecording.getState();
    if (activeSessionId !== sessionId) return;
    useActiveRecording.setState({ sessionId: null, origin: null });
    if (action === "discard") return;
    void bridge
      .stopSkillRecording(sessionId)
      .catch(() => ({ status: "failed" as const }))
      .then((result) => {
        if (result.status === "stopped") return open(result, origin);
        toastManager.add({
          type: "error",
          title: "The recording ended unexpectedly",
          description: "Nothing was kept. Try again.",
        });
      });
  });
  useEffect(
    () =>
      bridge.onSkillRecordingControl?.(({ sessionId, action }) => handleControl(sessionId, action)),
    [bridge],
  );

  return null;
}
