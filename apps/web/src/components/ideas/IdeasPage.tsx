/**
 * The Ideas page: suggestion cards for what TritonAI could do next, grouped by
 * where they came from. Opening one starts a draft the user reviews before
 * sending. Dismiss, snooze, "Less like this", and "Not relevant" hide a card
 * with an Undo; the server uses them to decide what to suggest later.
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  Idea,
  IdeaFeedbackKind,
  IdeaSection,
  IdeasFeedbackInput,
} from "@t3tools/contracts";
import { ChevronRightIcon, ClockIcon, EllipsisIcon, SparklesIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { isElectron } from "../../env";
import { useClientSettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { resolveSnoozePresets, snoozeWakeDescription } from "../Sidebar.snooze";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { useOpenIdeaDraft } from "./useOpenIdeaDraft";

const SECTIONS: ReadonlyArray<{ readonly section: IdeaSection; readonly title: string }> = [
  { section: "continue", title: "Pick up where you left off" },
  { section: "projects", title: "From your projects" },
  { section: "tools", title: "Try with your tools" },
  { section: "new", title: "New in TritonAI" },
  { section: "starter", title: "Ideas to try" },
];

type HideKind = Extract<IdeaFeedbackKind, "dismissed" | "rejected" | "less-like-this" | "snoozed">;

// While ideas are being written, check back this often.
const GENERATING_REFRESH_MS = 1_500;

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

export function IdeasPage() {
  const environmentId = usePrimaryEnvironmentId();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const { data, dataUpdatedAt, error, refresh } = useEnvironmentQuery(
    environmentId ? serverEnvironment.ideas({ environmentId, input: {} }) : null,
  );
  const markViewed = useAtomCommand(serverEnvironment.markIdeasViewed, { reportFailure: false });
  const suggestMore = useAtomCommand(serverEnvironment.suggestMoreIdeas, { reportFailure: false });
  const sendFeedback = useAtomCommand(serverEnvironment.sendIdeaFeedback, { reportFailure: false });
  const openDraft = useOpenIdeaDraft(environmentId);
  // Cards hidden by a press, shown again if saving it fails, until the list reloads.
  const [hiddenPresses, setHiddenPresses] = useState<{
    readonly loadedAt: number | null;
    readonly ids: ReadonlySet<string>;
  }>(() => ({ loadedAt: null, ids: new Set() }));
  const hidden = hiddenPresses.loadedAt === dataUpdatedAt ? hiddenPresses.ids : new Set<string>();
  const setHidden = (update: (ids: ReadonlySet<string>) => ReadonlySet<string>) =>
    setHiddenPresses((previous) => ({
      loadedAt: dataUpdatedAt,
      ids: update(previous.loadedAt === dataUpdatedAt ? previous.ids : new Set()),
    }));
  const [requesting, setRequesting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Opening the page records recent use; a first visit also starts personal ideas.
  const [viewedEnvironmentId, setViewedEnvironmentId] = useState<EnvironmentId | null>(null);
  useEffect(() => {
    if (environmentId === null) return;
    void markViewed({ environmentId, input: {} }).then(() => {
      setViewedEnvironmentId(environmentId);
      refresh();
    });
  }, [environmentId, markViewed, refresh]);

  // Keep view tracking current while new ideas arrive on the page.
  const unseenCount = data?.unseenCount ?? 0;
  useEffect(() => {
    if (environmentId === null || viewedEnvironmentId !== environmentId || unseenCount === 0) {
      return;
    }
    void markViewed({ environmentId, input: {} }).then(() => refresh());
  }, [environmentId, markViewed, refresh, unseenCount, viewedEnvironmentId]);

  useEffect(() => {
    if (data?.state !== "generating") return;
    const timer = setTimeout(() => refresh(), GENERATING_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [data, refresh]);

  const runFeedback = async (
    idea: Idea,
    kind: IdeaFeedbackKind,
    extra: Pick<IdeasFeedbackInput, "snoozedUntil" | "draftThreadId"> = {},
  ): Promise<boolean> => {
    if (environmentId === null) return false;
    const hides = kind !== "opened" && kind !== "restored";
    if (hides) setHidden((ids) => new Set(ids).add(idea.id));
    const result = await sendFeedback({
      environmentId,
      input: {
        ideaId: idea.id,
        kind,
        ...extra,
      },
    });
    if (result._tag === "Failure") {
      if (hides) {
        setHidden((ids) => {
          const next = new Set(ids);
          next.delete(idea.id);
          return next;
        });
      }
      if (!isAtomCommandInterrupted(result)) {
        setActionError(failureMessage(result, "Couldn't save that change."));
      }
      return false;
    }
    setActionError(null);
    refresh();
    return true;
  };

  const hideIdea = async (idea: Idea, kind: HideKind, snoozedUntil?: string) => {
    if (!(await runFeedback(idea, kind, snoozedUntil === undefined ? {} : { snoozedUntil }))) {
      return;
    }
    const title =
      kind === "snoozed" && snoozedUntil !== undefined
        ? `Snoozed until ${snoozeWakeDescription(snoozedUntil, new Date(), timestampFormat)}`
        : kind === "rejected"
          ? "We won't suggest that again"
          : kind === "less-like-this"
            ? "You'll see fewer ideas like this"
            : "Idea dismissed";
    toastManager.add({
      type: "success",
      title,
      ...(kind === "dismissed"
        ? { description: "It can come back in a couple of weeks if it still fits." }
        : {}),
      actionProps: {
        children: "Undo",
        onClick: () => void runFeedback(idea, "restored"),
      },
    });
  };

  const handleOpen = async (idea: Idea) => {
    setActionError(null);
    // An existing thread's message identities are the baseline for noticing the send, so the
    // open is recorded before its composer can send anything.
    if (idea.action.kind === "resume-thread") {
      if (!(await runFeedback(idea, "opened"))) return;
      await openDraft(idea);
      return;
    }
    const opened = await openDraft(idea);
    if (!opened) {
      setActionError("Add a project first, then open this idea.");
      return;
    }
    void runFeedback(
      idea,
      "opened",
      opened.draftThreadId === null ? {} : { draftThreadId: opened.draftThreadId },
    );
  };

  const handleSuggestMore = async () => {
    if (environmentId === null) return;
    setRequesting(true);
    setActionError(null);
    const result = await suggestMore({ environmentId, input: {} });
    setRequesting(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setActionError(failureMessage(result, "Couldn't load more ideas."));
    }
    refresh();
  };

  const visible = (data?.ideas ?? []).filter((idea) => !hidden.has(idea.id));
  const snoozed = (data?.snoozed ?? []).filter((idea) => !hidden.has(idea.id));
  const generating = requesting || data?.state === "generating";

  let content;
  if (environmentId === null) {
    content = <p className="text-sm text-muted-foreground">Connect to TritonAI to see ideas.</p>;
  } else if (data === null && error !== null) {
    content = (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button size="sm" variant="outline" onClick={() => refresh()}>
          Try again
        </Button>
      </div>
    );
  } else if (data === null) {
    content = <p className="text-sm text-muted-foreground">Loading ideas…</p>;
  } else {
    content = (
      <>
        {SECTIONS.map(({ section, title }) => {
          const ideas = visible.filter((idea) => idea.section === section);
          if (ideas.length === 0) return null;
          return (
            <section key={section} aria-label={title} className="flex flex-col gap-1">
              <h2 className="px-3 text-sm font-semibold text-foreground">{title}</h2>
              <ul className="flex flex-col">
                {ideas.map((idea) => (
                  <li key={idea.id}>
                    <IdeaCard
                      idea={idea}
                      timestampFormat={timestampFormat}
                      onOpen={handleOpen}
                      onHide={hideIdea}
                    />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        {visible.length === 0 && !generating ? (
          <p className="px-3 text-sm text-muted-foreground">
            You're all caught up. Ask for more ideas below.
          </p>
        ) : null}
        {snoozed.length > 0 ? (
          <SnoozedIdeas
            ideas={snoozed}
            timestampFormat={timestampFormat}
            onWake={(idea) => void runFeedback(idea, "restored")}
          />
        ) : null}
        <div className="flex flex-col items-center gap-2 pt-2">
          <Button
            variant="outline"
            onClick={() => void handleSuggestMore()}
            disabled={generating}
            aria-busy={generating}
          >
            <SparklesIcon />
            {generating ? "Finding ideas…" : "Suggest more"}
          </Button>
          {data.message && !generating ? (
            <p className="text-center text-xs text-muted-foreground">{data.message}</p>
          ) : null}
        </div>
      </>
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Ideas breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <h1>Ideas</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer className="gap-5">
            <p className="px-3 text-sm text-muted-foreground">
              Suggestions from your recent work, your tools, and what TritonAI can do. Opening one
              starts a draft you can change before sending.
            </p>
            {actionError ? (
              <p role="alert" className="px-3 text-sm text-destructive-foreground">
                {actionError}
              </p>
            ) : null}
            {content}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

type TimestampFormat = Parameters<typeof resolveSnoozePresets>[1];

function IdeaCard({
  idea,
  timestampFormat,
  onOpen,
  onHide,
}: {
  idea: Idea;
  timestampFormat: TimestampFormat;
  onOpen: (idea: Idea) => void;
  onHide: (idea: Idea, kind: HideKind, snoozedUntil?: string) => void;
}) {
  return (
    <article
      aria-label={idea.title}
      className="flex gap-3 rounded-lg p-3 focus-within:bg-muted/50 hover:bg-muted/50"
    >
      <span aria-hidden className="mt-0.5 w-7 shrink-0 text-center text-2xl leading-none">
        {idea.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 text-sm font-medium text-foreground">{idea.title}</h3>
          {idea.openedAt !== null ? (
            <Badge variant="info" size="sm">
              Draft open
            </Badge>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{idea.body}</p>
        {idea.sources.length > 0 ? (
          <ul aria-label="Based on" className="mt-2 flex flex-wrap gap-1">
            {idea.sources.map((source) => (
              <li key={source.label}>
                <Badge variant="outline" size="sm">
                  {source.label}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-2.5 flex flex-wrap items-center gap-1">
          <Button size="xs" onClick={() => onOpen(idea)}>
            {idea.action.kind === "resume-thread" ? "Continue in thread" : "Open draft"}
          </Button>
          <IdeaSnoozeMenu
            timestampFormat={timestampFormat}
            onSnooze={(snoozedUntil) => onHide(idea, "snoozed", snoozedUntil)}
          />
          <Button size="xs" variant="ghost" onClick={() => onHide(idea, "dismissed")}>
            <XIcon />
            Dismiss
          </Button>
          <Menu>
            <MenuTrigger
              render={<Button size="icon-xs" variant="ghost" aria-label="More options" />}
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="start">
              <MenuItem onClick={() => onHide(idea, "less-like-this")}>Less like this</MenuItem>
              <MenuItem onClick={() => onHide(idea, "rejected")}>Not relevant</MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
    </article>
  );
}

function IdeaSnoozeMenu({
  timestampFormat,
  onSnooze,
}: {
  timestampFormat: TimestampFormat;
  onSnooze: (snoozedUntil: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Resolved when the menu opens, so "In 1 hour" counts from the click.
  const presets = open ? resolveSnoozePresets(new Date(), timestampFormat) : [];
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger render={<Button size="xs" variant="ghost" />}>
        <ClockIcon />
        Snooze
      </MenuTrigger>
      <MenuPopup align="start">
        {presets.map((preset) => (
          <MenuItem key={preset.id} onClick={() => onSnooze(preset.snoozedUntil)}>
            {preset.label}
            <MenuShortcut>{preset.whenLabel}</MenuShortcut>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem
          onClick={async () => {
            const choice = await requestCustomSnooze();
            if (choice) onSnooze(choice.snoozedUntil);
          }}
        >
          Custom…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function SnoozedIdeas({
  ideas,
  timestampFormat,
  onWake,
}: {
  ideas: ReadonlyArray<Idea>;
  timestampFormat: TimestampFormat;
  onWake: (idea: Idea) => void;
}) {
  return (
    <div className="mx-3">
      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 text-sm font-semibold text-foreground">
          <ChevronRightIcon className="size-4 transition-transform group-data-[panel-open]:rotate-90" />
          Snoozed ({ideas.length})
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <ul className="mt-2 flex flex-col gap-2">
            {ideas.map((idea) => (
              <li key={idea.id} className="flex items-center gap-3">
                <span aria-hidden className="w-7 shrink-0 text-center text-lg leading-none">
                  {idea.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">{idea.title}</p>
                  {idea.snoozedUntil ? (
                    <p className="text-xs text-muted-foreground">
                      Back {snoozeWakeDescription(idea.snoozedUntil, new Date(), timestampFormat)}
                    </p>
                  ) : null}
                </div>
                <Button size="xs" variant="ghost" onClick={() => onWake(idea)}>
                  Unsnooze
                </Button>
              </li>
            ))}
          </ul>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
