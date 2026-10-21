import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  type ProjectBriefCommand,
  type ProjectBriefState,
  type ProjectId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { mergeEnvironmentSettings, useClientSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { randomUUID } from "../../lib/utils";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useProject } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { ProjectBriefContent, type ProjectBriefAction } from "./ProjectBriefContent";
import { ProjectMessageSourcePicker } from "./ProjectMessageSourcePicker";
import { ProjectBriefArchiveView } from "./ProjectBriefArchiveView";

export function ProjectBriefPage({
  environmentId,
  projectId,
  archiveId,
  onArchiveChange,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  archiveId: string | null;
  onArchiveChange: (archiveId: string | null) => void;
}) {
  const navigate = useNavigate();
  const environment = useEnvironment(environmentId);
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const query = useEnvironmentQuery(
    connected ? serverEnvironment.projectBriefLive({ environmentId, input: { projectId } }) : null,
  );
  const archiveQuery = useEnvironmentQuery(
    connected && archiveId
      ? serverEnvironment.projectBriefArchive({ environmentId, input: { projectId, archiveId } })
      : null,
  );
  const canWrite = useAtomValue(
    serverEnvironment.executeProjectBrief.permissionAtom(environmentId),
  );
  const execute = useAtomCommand(serverEnvironment.executeProjectBrief, { reportFailure: false });
  const [responseState, setResponseState] = useState<ProjectBriefState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [selectedModel, setSelectedModel] = useState<ModelSelection | null>(null);
  const clientSettings = useClientSettings();
  const settings = mergeEnvironmentSettings(
    environment?.serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
    clientSettings,
  );
  const projectSettings = resolveProjectSettings(
    settings,
    projectId,
    project ?? undefined,
  ).settings;
  const providers = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const modelSelection =
    selectedModel ??
    resolveDefaultProviderModelSelection(providers, projectSettings.defaultModelSelection);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, projectId),
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    modelSelection?.instanceId,
    modelSelection?.model,
  );
  const modelReady =
    modelSelection !== null &&
    entries.some(
      (entry) =>
        entry.instanceId === modelSelection.instanceId && isProviderInstancePickerReady(entry),
    );
  const liveState = query.data;
  const state =
    liveState && (!responseState || liveState.revision >= responseState.revision)
      ? liveState
      : responseState;

  async function run(action: ProjectBriefAction): Promise<boolean> {
    if (inFlight.current || !canWrite || !connected || !state || query.error) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const command: ProjectBriefCommand = {
      ...action,
      ...(modelSelection && (action.action === "generate" || action.action === "launch")
        ? { modelSelection }
        : {}),
      requestId: randomUUID(),
      projectId,
      expectedRevision: state.revision,
    };
    try {
      const response = await execute({ environmentId, input: command });
      if (response._tag !== "Success") {
        const cause = squashAtomCommandFailure(response);
        setError(
          cause instanceof Error
            ? cause.message
            : "The request could not be completed. Refresh the brief before retrying.",
        );
        query.refresh();
        return false;
      }
      setResponseState(response.value);
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The connection interrupted this request. Refresh the brief to check what happened.",
      );
      query.refresh();
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <main
      className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto"
      aria-labelledby="project-brief-title"
    >
      <div className="mx-auto w-full max-w-6xl px-5 py-7 sm:px-8 sm:py-10">
        <header className="mb-8 border-b border-border pb-5">
          <p className="mb-2 text-xs text-muted-foreground">
            {environment?.label ?? "Environment"} / {project?.title ?? "Project"}
          </p>
          <h1 id="project-brief-title" className="text-2xl font-semibold tracking-tight">
            {archiveId ? "Saved project brief" : "Project brief"}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Selected evidence, decisions and work that comes back for your review.
          </p>
        </header>
        {archiveId ? (
          <div className="mb-5">
            <Button size="sm" variant="outline" onClick={() => onArchiveChange(null)}>
              Back to current brief
            </Button>
          </div>
        ) : null}
        {!connected ? (
          <div role="status" className="space-y-2">
            <h2 className="text-base font-medium">Reconnect to this environment</h2>
            <p className="text-sm text-muted-foreground">
              Your brief will be available when {environment?.label ?? "the environment"}{" "}
              reconnects.
            </p>
          </div>
        ) : !project ? (
          <p role="status" className="text-sm text-muted-foreground">
            This project is no longer available in the selected environment.
          </p>
        ) : archiveId ? (
          archiveQuery.error ? (
            <div role="alert" className="space-y-3">
              <h2 className="text-base font-medium">Could not read this saved brief</h2>
              <p className="text-sm text-muted-foreground">{archiveQuery.error}</p>
              <Button size="sm" variant="outline" onClick={archiveQuery.refresh}>
                Try again
              </Button>
            </div>
          ) : !archiveQuery.data || archiveQuery.data.id !== archiveId ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading saved brief…
            </p>
          ) : (
            <ProjectBriefArchiveView
              key={archiveQuery.data.id}
              archive={archiveQuery.data}
              openThread={(threadId) => {
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId, threadId },
                });
              }}
            />
          )
        ) : query.error ? (
          <div role="alert" className="space-y-3">
            <h2 className="text-base font-medium">Could not read this brief</h2>
            <p className="text-sm text-muted-foreground">{query.error}</p>
            <Button variant="outline" size="sm" onClick={query.refresh}>
              Try again
            </Button>
          </div>
        ) : !state ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading project brief…
          </p>
        ) : (
          <ProjectBriefContent
            state={state}
            busy={busy}
            error={error}
            canWrite={canWrite}
            run={run}
            modelReady={modelReady}
            openArchive={onArchiveChange}
            renderMessagePicker={(onSelect) => (
              <ProjectMessageSourcePicker
                environmentId={environmentId}
                projectId={projectId}
                disabled={busy || !canWrite}
                onSelect={onSelect}
              />
            )}
            openThread={(threadId) => {
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId },
              });
            }}
            modelControl={
              modelSelection ? (
                <ProviderModelPicker
                  environmentId={environmentId}
                  activeInstanceId={modelSelection.instanceId}
                  model={modelSelection.model}
                  lockedProvider={null}
                  instanceEntries={entries}
                  modelOptionsByInstance={modelOptions}
                  disabled={busy || !canWrite}
                  triggerAriaLabel="Model for project work"
                  onInstanceModelChange={(instanceId, model) =>
                    setSelectedModel(createModelSelection(instanceId, model))
                  }
                  onOpenProviderSetup={(instanceId) => {
                    void navigate({
                      to: "/settings/providers",
                      search: { environmentId, instanceId },
                    });
                  }}
                />
              ) : (
                <span className="text-xs text-muted-foreground">
                  Connect an agent provider to generate a brief.
                </span>
              )
            }
          />
        )}
      </div>
    </main>
  );
}
