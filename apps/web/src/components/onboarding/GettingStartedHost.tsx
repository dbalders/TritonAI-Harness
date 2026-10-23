import type { GettingStartedChapterId, IntegrationSummary } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { APP_BASE_NAME } from "../../branding";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  GETTING_STARTED_CHAPTERS,
  GETTING_STARTED_SAMPLE,
} from "../../onboarding/gettingStarted.logic";
import {
  openGettingStarted,
  updateGettingStarted,
  useGettingStarted,
  useGettingStartedEnabled,
} from "../../onboarding/gettingStartedState";
import { useGettingStartedActions } from "../../onboarding/useGettingStartedActions";
import { isTritonAiCodeBrand } from "../../tritonAiWorkspace";
import { Button } from "../ui/button";
import { useSidebar } from "../ui/sidebar";
import { GettingStartedPanel } from "./GettingStartedPanel";
import { GettingStartedEntryButton } from "./GettingStartedEntryButton";
import { useIntegrationConnection } from "./useIntegrationConnection";

export function GettingStartedSidebarEntry() {
  const environmentId = usePrimaryEnvironmentId();
  const state = useGettingStarted();
  const enabled = useGettingStartedEnabled();
  const { isMobile, setOpenMobile } = useSidebar();
  if (!enabled || !environmentId || !isTritonAiCodeBrand(APP_BASE_NAME)) return null;
  return (
    <GettingStartedEntryButton
      active={state.open && !state.paused}
      progressLabel={
        state.startedAt
          ? `${state.completed.length} of ${GETTING_STARTED_CHAPTERS.length} chapters · ${state.paused ? "Paused" : "Resume anytime"}`
          : "Learn, connect, and try something useful"
      }
      onClick={() => {
        if (isMobile) setOpenMobile(false);
        void openGettingStarted(environmentId);
      }}
    />
  );
}

function usableMail(integration: IntegrationSummary | null): boolean {
  return Boolean(
    integration?.installed &&
    integration.enabled &&
    integration.connectionState === "connected" &&
    integration.capabilities.some(
      (item) => item.id === "mail.read" && item.enabled && item.available,
    ),
  );
}

/** The chapter tray never replaces a route or traps focus; exercises use ordinary app controls. */
export function GettingStartedHost() {
  const state = useGettingStarted();
  const enabled = useGettingStartedEnabled();
  const environmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { prepare, pending, error } = useGettingStartedActions(environmentId);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [computerHelpGeneration, setComputerHelpGeneration] = useState<number | null>(null);
  const computerHelpSeen = computerHelpGeneration === state.generation;
  const relevantConnection =
    enabled &&
    state.startedAt !== null &&
    !state.paused &&
    state.environmentId === environmentId &&
    ["connect", "connected-work"].includes(state.activeChapter);
  const connectionEnvironment = relevantConnection ? environmentId : null;
  const refreshKey = `${pathname}:${connectionRevision}`;
  const microsoft = useIntegrationConnection("microsoft-365", connectionEnvironment, refreshKey);
  const google = useIntegrationConnection("google-workspace", connectionEnvironment, refreshKey);
  const mail =
    microsoft.status === "connected" && usableMail(microsoft.integration)
      ? microsoft
      : google.status === "connected" && usableMail(google.integration)
        ? google
        : null;

  useEffect(() => {
    if (!relevantConnection) return;
    const refresh = () => setConnectionRevision((value) => value + 1);
    window.addEventListener("focus", refresh);
    window.addEventListener("getting-started:connections-changed", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("getting-started:connections-changed", refresh);
    };
  }, [relevantConnection]);

  useEffect(() => {
    if (
      mail &&
      environmentId &&
      state.activeChapter === "connect" &&
      !state.completed.includes("connect")
    ) {
      void updateGettingStarted({
        type: "connection-ready",
        environmentId,
        generation: state.generation,
      });
    }
  }, [environmentId, mail, state.activeChapter, state.completed, state.generation]);

  if (
    !enabled ||
    !state.open ||
    state.paused ||
    !state.startedAt ||
    !environmentId ||
    !isTritonAiCodeBrand(APP_BASE_NAME) ||
    pathname === "/guided-tour"
  )
    return null;
  const chapter =
    GETTING_STARTED_CHAPTERS.find((item) => item.id === state.activeChapter) ??
    GETTING_STARTED_CHAPTERS[0];
  const done = state.completed.includes(chapter.id);
  const generation = state.generation;
  const select = (next: GettingStartedChapterId) =>
    void updateGettingStarted({ type: "select", chapter: next });
  const next = () =>
    void updateGettingStarted({ type: "next", generation, fromChapter: chapter.id });
  const openPlugins = async () => {
    await navigate({ to: "/settings/plugins" });
    await updateGettingStarted({ type: "close", generation, fromChapter: chapter.id });
  };
  const openIdeas = async () => {
    await navigate({ to: "/ideas" });
    await updateGettingStarted({ type: "close", generation, fromChapter: chapter.id });
  };
  let title: string = chapter.title;
  let description: string = chapter.description;
  let target: string | null = null;
  let content;

  if (chapter.id === "welcome") {
    title = "A little help with your everyday work";
    description =
      "Use ordinary words to ask questions, work with files, and get help across the accounts you choose to connect. These chapters stay beside you in the app.";
    content = (
      <>
        <p className="text-sm text-muted-foreground">
          Try a conversation, connect your work, explore Ideas, and decide whether computer use is
          useful for you. You can pause or skip a chapter anytime.
        </p>
        <Button
          size="sm"
          onClick={async () => {
            await updateGettingStarted({
              type: "acknowledge",
              chapter: "welcome",
              continue: "next",
              generation,
            });
          }}
        >
          Let's try a conversation
        </Button>
      </>
    );
  } else if (chapter.id === "conversation") {
    title = done ? "You can keep a conversation going" : "Start with a simple request";
    description =
      "Try fictional meeting notes, ask a follow-up, and check a detail against the source. Every request stays editable until you send it.";
    target = "composer";
    content = (
      <>
        <Button
          size="sm"
          disabled={pending}
          onClick={() => void prepare("conversation", GETTING_STARTED_SAMPLE)}
        >
          {pending ? "Preparing…" : "Prepare a practice conversation"}
        </Button>
        <p className="text-xs text-muted-foreground">
          The sample is sent to your configured AI service when you press Send. Your personal
          accounts are not needed.
        </p>
      </>
    );
  } else if (chapter.id === "connect" || chapter.id === "connected-work") {
    title =
      chapter.id === "connect"
        ? mail
          ? "Your email is available"
          : "Connect Outlook or Gmail"
        : "Put your connection to use";
    description =
      "Review the access you enable in Plugins. You'll sign in on Microsoft's or Google's own page. Information read for a request goes to your configured AI service.";
    target = pathname === "/settings/plugins" ? "connections" : "settings";
    content = (
      <>
        {mail ? (
          <p className="text-sm">
            Connected: <strong>{mail.integration?.accountLabel ?? mail.integration?.name}</strong>.
            You can change access or disconnect in Plugins.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {microsoft.status === "loading" || google.status === "loading"
              ? "Checking available accounts…"
              : microsoft.status === "failed" || google.status === "failed"
                ? "The connection status could not be checked. Open Plugins or try checking again."
                : microsoft.status === "unavailable" && google.status === "unavailable"
                  ? "Email plugins aren't included in this build. You can keep learning with samples and connect later."
                  : "An account must be connected with email reading enabled before this exercise can use it."}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={openPlugins}>
            Open Plugins
          </Button>
          <Button
            size="sm"
            variant="ghost-muted"
            onClick={() => setConnectionRevision((value) => value + 1)}
          >
            Check connection
          </Button>
        </div>
        {mail && chapter.id === "connected-work" ? (
          <Button
            size="sm"
            disabled={pending}
            onClick={() => {
              const integration = mail.integration;
              if (!integration) return;
              const names = integration.tools
                .filter(
                  (tool) =>
                    tool.available &&
                    tool.effect === "read" &&
                    tool.capabilities.includes("mail.read"),
                )
                .map((tool) => tool.name);
              void prepare(
                "connected-work",
                `Use my connected ${integration.id === "microsoft-365" ? "Outlook" : "Gmail"} account to find messages from yesterday that ask me a question. List who sent each message and what they need, with source links where available. Only read; don't draft, change, move, or send anything.`,
                names,
              );
            }}
          >
            Prepare my first email request
          </Button>
        ) : null}
        {chapter.id === "connect" && done ? (
          <Button size="sm" onClick={next}>
            Try a connected task
          </Button>
        ) : null}
      </>
    );
  } else if (chapter.id === "files") {
    title = "Show it the material you want help with";
    description =
      "Attach a suitable file using the paperclip in the normal composer. Explain what you need from it. A project keeps related work and conversations together.";
    target = "composer";
    content = (
      <>
        <p className="text-xs text-muted-foreground">
          Check the material is appropriate for your configured AI service. This exercise asks for
          an answer in chat and makes no file changes.
        </p>
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            void prepare(
              "files",
              "Summarize the file I attach in five short bullets, then identify any important missing information. Answer here in chat; don't save or change any files.",
            )
          }
        >
          Open a file conversation
        </Button>
      </>
    );
  } else if (chapter.id === "ideas") {
    title = "Find a useful next step";
    description =
      "Ideas is the lightbulb in the sidebar. Each card explains what it is based on and prepares a request you can review before sending. You can dismiss or snooze ideas that don't fit.";
    target = "ideas";
    content = (
      <>
        <Button size="sm" onClick={() => void openIdeas()}>
          Explore Ideas
        </Button>
        <p className="text-xs text-muted-foreground">
          Opening a card leaves its request unsent. This chapter completes after you send the idea
          and receive an answer.
        </p>
      </>
    );
  } else if (chapter.id === "computer-use") {
    title = "Choose whether it can work with desktop apps";
    description =
      "Computer use lets the assistant see the screen and control the mouse and keyboard. It is optional and currently needs a supported local desktop setup with Codex.";
    target = "computer-use";
    const desktopAvailable =
      typeof window !== "undefined" && Boolean(window.desktopBridge?.getComputerUseState);
    content = (
      <>
        <p className="text-xs text-muted-foreground">
          On macOS, setup asks for Accessibility and Screen Recording access and may need a restart.
          The real setting explains readiness. Use the conversation's stop control to interrupt a
          task.
        </p>
        {desktopAvailable ? (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await navigate({ to: "/settings/general", hash: "computer-use" });
              setComputerHelpGeneration(state.generation);
              await updateGettingStarted({ type: "close", generation, fromChapter: chapter.id });
            }}
          >
            Show computer-use settings
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            This browser cannot control your desktop. Open the desktop app to explore this setting.
          </p>
        )}
        {computerHelpSeen || !desktopAvailable ? (
          <Button
            size="sm"
            onClick={async () => {
              await updateGettingStarted({
                type: "acknowledge",
                chapter: "computer-use",
                continue: "next",
                generation,
              });
            }}
          >
            I understand the choice
          </Button>
        ) : null}
        <p className="text-xs text-muted-foreground">
          This chapter explains the choice. Understanding it does not mean computer use is enabled
          or a task has been tested.
        </p>
      </>
    );
  } else {
    title = "What would you like help with next?";
    description =
      "Continue your conversation, choose an idea, or return to a chapter later. Getting started stays in the sidebar and command palette.";
    content = (
      <>
        <p className="text-sm">
          {state.completed.length} chapters complete · {state.deferred.length} saved for later. You
          can revisit any chapter without deleting your conversations.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void openIdeas()}>
            Open Ideas
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await updateGettingStarted({
                type: "acknowledge",
                chapter: "ready",
                continue: "pause",
                generation,
              });
            }}
          >
            Keep working
          </Button>
        </div>
      </>
    );
  }

  return (
    <aside
      className="pointer-events-none fixed top-[calc(var(--workspace-topbar-height,3rem)+1rem)] right-3 z-40 w-[min(23rem,calc(100vw-1.5rem))] sm:right-4"
      aria-label="Getting started chapters"
    >
      <div className="pointer-events-auto">
        <GettingStartedPanel
          chapters={GETTING_STARTED_CHAPTERS.map((item) => ({
            ...item,
            status: state.completed.includes(item.id)
              ? "complete"
              : state.deferred.includes(item.id)
                ? "later"
                : "available",
          }))}
          activeChapterId={state.activeChapter}
          title={title}
          description={description}
          target={target}
          progressLabel={`${state.completed.length} of ${GETTING_STARTED_CHAPTERS.length} chapters complete`}
          onSelectChapter={(id) => {
            if (GETTING_STARTED_CHAPTERS.some((item) => item.id === id))
              select(id as GettingStartedChapterId);
          }}
          onPause={() => void updateGettingStarted({ type: "pause", generation })}
          onClose={() => void updateGettingStarted({ type: "close", generation })}
          onRestart={() => void updateGettingStarted({ type: "restart", generation })}
        >
          {state.environmentId !== environmentId ? (
            <p role="status" className="text-sm">
              This guide belongs to another connected computer. Open Getting started again to begin
              on this one.
            </p>
          ) : (
            <div className="grid gap-3">
              {content}
              {error ? (
                <div role="alert" className="grid gap-2 text-xs text-destructive">
                  <p>{error}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void navigate({ to: "/settings/providers" })}
                  >
                    Open Runtime settings
                  </Button>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {done && !["welcome", "connect", "computer-use", "ready"].includes(chapter.id) ? (
                  <Button size="sm" onClick={next}>
                    Next chapter
                  </Button>
                ) : null}
                {chapter.id !== "ready" ? (
                  <Button
                    size="sm"
                    variant="ghost-muted"
                    onClick={() =>
                      void updateGettingStarted({
                        type: "later",
                        generation,
                        fromChapter: chapter.id,
                      })
                    }
                  >
                    Do this later
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </GettingStartedPanel>
      </div>
    </aside>
  );
}
