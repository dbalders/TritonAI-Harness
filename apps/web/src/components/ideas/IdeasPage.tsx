/**
 * Ideas open as drafts for review. Row feedback hides the card with Undo and
 * informs future suggestions in For you and Things to try. Features the user
 * hasn't tried yet wait, collapsed, above them until tried.
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, Idea, IdeaFeedbackKind, IdeasFeedbackInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ChevronRightIcon, ClockIcon, EllipsisIcon, SparklesIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
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
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  featureIdeas,
  IDEA_GROUPS,
  ideaBasis,
  ideaHeadline,
  ideasInGroup,
  type IdeaGroup,
} from "./ideaDisplay";
import { useOpenIdeaDraft } from "./useOpenIdeaDraft";
import { GettingStartedContextHint } from "../onboarding/GettingStartedContextHint";

type HideKind = Extract<IdeaFeedbackKind, "dismissed" | "rejected" | "less-like-this" | "snoozed">;

// While ideas are being written, check back this often.
const GENERATING_REFRESH_MS = 1_500;
const FEATURES_EXPANDED_KEY = "t3code:ideas:features-expanded";

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
      // A dismissed feature card doesn't come back.
      ...(kind === "dismissed" && idea.section !== "feature"
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
  const features = featureIdeas(data?.features, hidden);
  const snoozed = [
    ...(data?.snoozed ?? []).filter((idea) => !hidden.has(idea.id)),
    ...features.snoozed,
  ].toSorted((left, right) => (left.snoozedUntil ?? "").localeCompare(right.snoozedUntil ?? ""));
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
        <div className="flex flex-col gap-1.5 px-2">
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 text-sm text-muted-foreground">
              Ready-to-send tasks from your work and tools. Nothing runs until you send it.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleSuggestMore()}
              disabled={generating}
              aria-busy={generating}
            >
              <SparklesIcon />
              {generating ? "Finding ideas…" : "Suggest more"}
            </Button>
          </div>
          {data.message && !generating ? (
            <p className="text-xs text-muted-foreground">{data.message}</p>
          ) : null}
        </div>
        {features.toTry.length > 0 ? (
          <FeatureIdeaList
            ideas={features.toTry}
            timestampFormat={timestampFormat}
            onOpen={handleOpen}
            onHide={hideIdea}
          />
        ) : null}
        {IDEA_GROUPS.map((group) => (
          <IdeaGroupList
            key={group.id}
            group={group}
            ideas={ideasInGroup(visible, group)}
            timestampFormat={timestampFormat}
            onOpen={handleOpen}
            onHide={hideIdea}
          />
        ))}
        {visible.length === 0 && !generating ? (
          <p className="px-2 text-sm text-muted-foreground">
            You're all caught up. Use Suggest more for new ideas.
          </p>
        ) : null}
        {snoozed.length > 0 ? (
          <SnoozedIdeas
            ideas={snoozed}
            timestampFormat={timestampFormat}
            onWake={(idea) => void runFeedback(idea, "restored")}
          />
        ) : null}
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
          <WorkspacePageContainer className="max-w-2xl gap-7">
            <GettingStartedContextHint chapters={["ideas"]} />
            {actionError ? (
              <p role="alert" className="px-2 text-sm text-destructive-foreground">
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

interface IdeaActions {
  readonly timestampFormat: TimestampFormat;
  readonly onOpen: (idea: Idea) => void;
  readonly onHide: (idea: Idea, kind: HideKind, snoozedUntil?: string) => void;
}

function IdeaGroupList({
  group,
  ideas,
  ...actions
}: IdeaActions & { group: IdeaGroup; ideas: ReadonlyArray<Idea> }) {
  if (ideas.length === 0) return null;
  return (
    <section aria-label={group.title} className="flex flex-col gap-1">
      <h2 className="flex items-baseline gap-1.5 px-2 text-sm font-semibold text-foreground">
        {group.title}
        <span className="font-normal text-muted-foreground">{ideas.length}</span>
      </h2>
      <ul className="flex flex-col divide-y divide-border/70">
        {ideas.map((idea) => (
          <li key={idea.id} className="py-0.5">
            <IdeaRow idea={idea} {...actions} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Features not tried yet, collapsed until opened so they don't crowd the page. */
function FeatureIdeaList({ ideas, ...actions }: IdeaActions & { ideas: ReadonlyArray<Idea> }) {
  const [expanded, setExpanded] = useLocalStorage(FEATURES_EXPANDED_KEY, false, Schema.Boolean);
  return (
    <section aria-label="New features to try">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger className="group flex items-center gap-1.5 px-2 text-sm font-semibold text-foreground">
          <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
          New features to try
          <span className="font-normal text-muted-foreground">{ideas.length}</span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <ul className="mt-1 flex flex-col divide-y divide-border/70">
            {ideas.map((idea) => (
              <li key={idea.id} className="py-0.5">
                <IdeaRow idea={idea} {...actions} />
              </li>
            ))}
          </ul>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}

function IdeaRow({ idea, timestampFormat, onOpen, onHide }: IdeaActions & { idea: Idea }) {
  const headline = ideaHeadline(idea.title);
  const basis = ideaBasis(idea.sources);
  return (
    <article
      aria-label={headline}
      className="group/idea flex flex-col gap-2 rounded-lg px-2 py-2.5 focus-within:bg-muted/50 hover:bg-muted/50 sm:flex-row sm:items-center sm:gap-3"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-base leading-none"
        >
          {idea.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <h3 className="min-w-0 text-sm font-medium text-foreground">{headline}</h3>
            {idea.openedAt !== null ? (
              <Badge variant="info" size="sm">
                Draft open
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">{idea.body}</p>
          {basis ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground/75">{basis}</p>
          ) : null}
        </div>
      </div>
      {/* Shown on hover or focus where the pointer can hover; always shown on touch screens. */}
      <div className="flex shrink-0 items-center gap-1 ps-11 transition-opacity sm:ps-0 sm:[@media(any-hover:hover)]:opacity-0 sm:[@media(any-hover:hover)]:group-hover/idea:opacity-100 sm:[@media(any-hover:hover)]:group-focus-within/idea:opacity-100 sm:[@media(any-hover:hover)]:has-[[data-popup-open]]:opacity-100">
        <Button size="xs" onClick={() => onOpen(idea)}>
          {idea.section === "feature"
            ? "Try it"
            : idea.action.kind === "resume-thread"
              ? "Continue in thread"
              : "Open draft"}
        </Button>
        <IdeaMoreMenu
          headline={headline}
          feature={idea.section === "feature"}
          timestampFormat={timestampFormat}
          onHide={(kind, snoozedUntil) => onHide(idea, kind, snoozedUntil)}
        />
      </div>
    </article>
  );
}

function IdeaMoreMenu({
  headline,
  feature,
  timestampFormat,
  onHide,
}: {
  headline: string;
  /** Feature cards only snooze or dismiss: there is no mix of them to steer. */
  feature: boolean;
  timestampFormat: TimestampFormat;
  onHide: (kind: HideKind, snoozedUntil?: string) => void;
}) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  // Resolved when the submenu opens, so "In 1 hour" counts from then.
  const [snoozeNow, setSnoozeNow] = useState(() => new Date());
  const presets = snoozeOpen ? resolveSnoozePresets(snoozeNow, timestampFormat) : [];
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="icon-xs" variant="ghost" aria-label={`More options for ${headline}`} />
        }
      >
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuSub
          open={snoozeOpen}
          onOpenChange={(open) => {
            if (open) setSnoozeNow(new Date());
            setSnoozeOpen(open);
          }}
        >
          <MenuSubTrigger>
            <ClockIcon />
            Snooze
          </MenuSubTrigger>
          <MenuSubPopup>
            {presets.map((preset) => (
              <MenuItem key={preset.id} onClick={() => onHide("snoozed", preset.snoozedUntil)}>
                {preset.label}
                <MenuShortcut>{preset.whenLabel}</MenuShortcut>
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem
              onClick={async () => {
                const choice = await requestCustomSnooze();
                if (choice) onHide("snoozed", choice.snoozedUntil);
              }}
            >
              Custom…
            </MenuItem>
          </MenuSubPopup>
        </MenuSub>
        <MenuItem onClick={() => onHide("dismissed")}>
          <XIcon />
          Dismiss
        </MenuItem>
        {feature ? null : (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => onHide("less-like-this")}>Less like this</MenuItem>
            <MenuItem onClick={() => onHide("rejected")}>Not relevant</MenuItem>
          </>
        )}
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
  const [now] = useState(() => new Date());
  return (
    <div className="px-2">
      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ChevronRightIcon className="size-4 transition-transform group-data-[panel-open]:rotate-90" />
          Snoozed ({ideas.length})
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <ul className="mt-2 flex flex-col gap-2">
            {ideas.map((idea) => (
              <li key={idea.id} className="flex items-center gap-3">
                <span
                  aria-hidden
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-base leading-none"
                >
                  {idea.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">{ideaHeadline(idea.title)}</p>
                  {idea.snoozedUntil ? (
                    <p className="text-xs text-muted-foreground">
                      Back {snoozeWakeDescription(idea.snoozedUntil, now, timestampFormat)}
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
