import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_SERVER_SETTINGS,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type ChatAttachment,
  type EnvironmentId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BadgeDollarSignIcon,
  CalendarIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FlaskConicalIcon,
  FolderOpenIcon,
  GraduationCapIcon,
  MailIcon,
  MessagesSquareIcon,
  MonitorCogIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from "react";

import { useComposerDraftStore, type ComposerFileAttachment } from "../../composerDraftStore";
import { waitForProject } from "../../firstRunOnboarding";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseAttachmentUpload,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { inferProjectTitleFromPath } from "../../lib/projectPaths";
import { cn, newMessageId, newProjectId, newThreadId, randomUUID } from "../../lib/utils";
import {
  GOOGLE_WORKSPACE_ID,
  MICROSOFT_365_ID,
  ONBOARDING_ROLES,
  accountName,
  accountTaskMessage,
  connectionAccess,
  fileTaskMessage,
  onboardingRole,
  onboardingTask,
  parseSampleTable,
  recommendedTaskId,
  taskNeedsAccount,
  taskNeedsMicrosoft,
  type OnboardingMailProvider,
  type OnboardingRole,
  type OnboardingRoleId,
  type OnboardingTask,
} from "../../onboarding/guidedOnboarding.logic";
import {
  updateGuidedTourState,
  useGuidedTourState,
  type GuidedTourStep,
} from "../../onboarding/guidedTourState";
import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import { useProjects, waitForThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { EMPTY_SERVER_PROVIDERS, environmentServerConfigsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  isTritonAiWorkspacePath,
  resolveTritonAiFirstRunWorkspacePath,
} from "../../tritonAiWorkspace";
import { resolveDesktopLocalFilePath } from "../chat/localFileAttachment";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { useIntegrationConnection, type IntegrationConnection } from "./useIntegrationConnection";

const ROLE_ICONS: Record<OnboardingRoleId, ReactNode> = {
  admin: <MailIcon />,
  research: <FlaskConicalIcon />,
  teaching: <GraduationCapIcon />,
  finance: <BadgeDollarSignIcon />,
  it: <MonitorCogIcon />,
  other: <SparklesIcon />,
};

const PROVIDER_LOGOS: Record<OnboardingMailProvider, string> = {
  "microsoft-365": "/integrations/microsoft.svg",
  "google-workspace": "/integrations/google.svg",
};

const PROVIDER_COMPANY: Record<OnboardingMailProvider, string> = {
  "microsoft-365": "Microsoft",
  "google-workspace": "Google",
};

const PROVIDER_TITLE: Record<OnboardingMailProvider, string> = {
  "microsoft-365": "Outlook & Teams",
  "google-workspace": "Gmail & Google",
};

const PROVIDER_ACCOUNT: Record<OnboardingMailProvider, string> = {
  "microsoft-365": "Microsoft 365",
  "google-workspace": "Google",
};

/**
 * The tour's conversation is Supervised: reading needs no approval, and saving a file
 * or using a plugin's write tool stops for Allow/Deny. That is the behavior the tour's
 * copy promises, so it does not follow a broader remembered composer mode.
 */
const TOUR_RUNTIME_MODE: RuntimeMode = "approval-required";

/** Find the TritonAI folder's project, creating the folder on first use. */
function useTritonAiProject(environmentId: EnvironmentId | null) {
  const projects = useProjects();
  const createProject = useAtomCommand(projectEnvironment.create, {
    label: "guided tour project create",
    reportFailure: false,
  });
  const existing = useMemo(
    () =>
      projects.find(
        (project) =>
          project.environmentId === environmentId && isTritonAiWorkspacePath(project.workspaceRoot),
      ) ?? null,
    [environmentId, projects],
  );
  // Remembers a project created here until the project list catches up, so a second
  // run never tries to create the folder again.
  const created = useRef<EnvironmentProject | null>(null);
  return useCallback(async (): Promise<EnvironmentProject | null> => {
    if (existing) return existing;
    if (created.current?.environmentId === environmentId) return created.current;
    if (!environmentId) return null;
    const workspacePath = resolveTritonAiFirstRunWorkspacePath();
    const projectId = newProjectId();
    const result = await createProject({
      environmentId,
      input: {
        projectId,
        title: inferProjectTitleFromPath(workspacePath) || "TritonAI",
        workspaceRoot: workspacePath,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: null,
      },
    });
    if (result._tag === "Failure") return null;
    created.current = await waitForProject({ environmentId, projectId, timeoutMs: 5_000 });
    return created.current;
  }, [createProject, environmentId, existing]);
}

/** Put their own file on the message: by path when this computer runs it, else uploaded. */
async function attachOwnFile(
  environmentId: EnvironmentId,
  file: File,
): Promise<{ readonly attachment: ChatAttachment; readonly release: () => void }> {
  const name = file.name || "file";
  const mimeType = file.type || "application/octet-stream";
  // The tour runs in the primary environment, which the desktop app hosts on this
  // computer; the resolver returns null in a browser or for a WSL backend.
  const path = resolveDesktopLocalFilePath({
    bridge: window.desktopBridge ?? null,
    backendId: PRIMARY_LOCAL_ENVIRONMENT_ID,
    file,
  });
  if (path) {
    return {
      attachment: { type: "file", id: randomUUID(), name, mimeType, sizeBytes: file.size, path },
      release: () => {},
    };
  }
  if (file.size === 0) throw new Error("That file is empty. Pick another one.");
  const upload: ComposerFileAttachment = {
    type: "file",
    id: randomUUID(),
    name,
    mimeType,
    sizeBytes: file.size,
    file,
  };
  startAttachmentUpload({ environmentId, image: upload });
  await awaitAttachmentUploads([upload.id]);
  const [uploaded] = getUploadedAttachments({ environmentId, images: [upload] }) ?? [];
  if (!uploaded) {
    const state = readAttachmentUpload(upload.id);
    releaseAttachmentUpload(upload.id);
    throw new Error(
      state?.status === "failed" && state.reason
        ? state.reason
        : "Couldn't upload that file. Try again, or pick a smaller one.",
    );
  }
  return { attachment: uploaded, release: () => releaseAttachmentUpload(upload.id) };
}

/* ------------------------------------------------------------------ shared pieces */

function StepHeading({
  eyebrow,
  title,
  children,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly children?: ReactNode;
}) {
  return (
    <div>
      <p className="mb-2.5 text-sm font-semibold text-primary">{eyebrow}</p>
      <h1 className="text-balance text-3xl font-semibold leading-tight tracking-tight text-foreground sm:text-4xl">
        {title}
      </h1>
      {children ? (
        <p className="mt-3 max-w-[36em] text-pretty text-lg leading-relaxed text-muted-foreground">
          {children}
        </p>
      ) : null}
    </div>
  );
}

function BackButton({ onClick }: { readonly onClick: () => void }) {
  return (
    <div className="mb-5">
      <Button variant="ghost-muted" size="sm" onClick={onClick}>
        <ArrowLeftIcon />
        Back
      </Button>
    </div>
  );
}

function FinePrint({ children }: { readonly children: ReactNode }) {
  return (
    <p className="mt-5 flex max-w-[44em] items-start gap-2 text-sm leading-relaxed text-muted-foreground">
      <ShieldCheckIcon className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function ProviderLogo({
  provider,
  className,
}: {
  readonly provider: OnboardingMailProvider;
  readonly className?: string;
}) {
  return <img src={PROVIDER_LOGOS[provider]} alt="" className={cn("size-6", className)} />;
}

function ErrorText({ children }: { readonly children: ReactNode }) {
  return (
    <p className="mt-3 text-sm text-destructive-foreground" role="alert">
      {children}
    </p>
  );
}

function taskIcon(task: OnboardingTask): ReactNode {
  switch (task.source) {
    case "file":
      return <FileTextIcon />;
    case "calendar":
      return <CalendarIcon />;
    case "teams":
      return <MessagesSquareIcon />;
    default:
      return <MailIcon />;
  }
}

function taskUses(task: OnboardingTask): string {
  switch (task.source) {
    case "file":
      return "Uses a file: a sample, or one of your own";
    case "calendar":
      return "Reads your calendar (Outlook or Google)";
    case "teams":
      return "Reads your Teams chats (Microsoft 365)";
    default:
      return "Reads your email (Outlook or Gmail)";
  }
}

/* ------------------------------------------------------------------ welcome */

const WELCOME_EXAMPLES = [
  {
    tab: "Notes",
    say: "“Turn my meeting notes into a to-do list.”",
    does: ["Reads the notes", "Works out who owns what, and by when", "Writes a tidy list"],
  },
  {
    tab: "Spreadsheets",
    say: "“Which budget lines are over, and by how much?”",
    does: ["Opens the spreadsheet", "Checks every line", "Shows you the ones to look at"],
  },
  {
    tab: "Email & calendar",
    say: "“What's on my calendar this week?”",
    does: [
      "Reads your calendar, if you connect it",
      "Picks out what matters",
      "Answers in plain words",
    ],
  },
] as const;

function WelcomeStep({ onNext }: { readonly onNext: () => void }) {
  const [index, setIndex] = useState(0);
  const example = WELCOME_EXAMPLES[index]!;
  return (
    <div className="mx-auto w-full max-w-[660px]">
      <StepHeading
        eyebrow="Welcome to TritonAI"
        title="An assistant that does the work, not just talks about it."
      >
        Ask in plain words. It can turn notes into documents, check spreadsheets, and find things
        across the accounts you choose to connect. In this tour it asks before it saves or changes
        anything.
      </StepHeading>
      <div className="mt-8 flex flex-wrap gap-1.5" role="group" aria-label="Examples">
        {WELCOME_EXAMPLES.map((item, itemIndex) => (
          <Button
            key={item.tab}
            size="sm"
            variant={itemIndex === index ? "secondary" : "ghost-muted"}
            aria-pressed={itemIndex === index}
            onClick={() => setIndex(itemIndex)}
          >
            {item.tab}
          </Button>
        ))}
      </div>
      <div
        key={example.tab}
        aria-live="polite"
        className="guided-onboarding-pop mt-3 grid grid-cols-1 items-stretch gap-3.5 sm:grid-cols-[1fr_auto_1fr]"
      >
        <div className="rounded-2xl border border-border bg-card p-5 shadow-lg/5 sm:min-h-[136px]">
          <p className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            You say
          </p>
          <p className="text-base text-foreground">{example.say}</p>
        </div>
        <div className="hidden place-items-center text-muted-foreground/60 sm:grid">
          <ArrowRightIcon className="size-5" />
        </div>
        <div className="rounded-2xl border border-border bg-card p-5 shadow-lg/5 sm:min-h-[136px]">
          <p className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            It does
          </p>
          <ul className="grid gap-2 text-sm text-foreground">
            {example.does.map((item) => (
              <li key={item} className="flex items-start gap-2">
                <span className="mt-px grid size-[18px] shrink-0 place-items-center rounded-full bg-success/15 text-success-foreground">
                  <CheckIcon className="size-2.5" strokeWidth={3.5} />
                </span>
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="mt-8">
        <Button size="xl" onClick={onNext}>
          Get started
          <ArrowRightIcon />
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ role */

function RoleStep({
  role,
  onSelect,
  onBack,
  onNext,
}: {
  readonly role: OnboardingRoleId | null;
  readonly onSelect: (role: OnboardingRoleId) => void;
  readonly onBack: () => void;
  readonly onNext: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-[660px]">
      <BackButton onClick={onBack} />
      <StepHeading eyebrow="Step 1 of 3" title="What kind of work do you do?">
        Pick the closest match. It only changes the examples we suggest.
      </StepHeading>
      <fieldset className="mt-8">
        <legend className="sr-only">Kind of work</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {ONBOARDING_ROLES.map((option) => (
            <label
              key={option.id}
              className="flex cursor-pointer flex-col items-start justify-start rounded-2xl border border-border bg-card p-4 text-left transition-[border-color,box-shadow] duration-200 hover:border-primary/30 has-checked:border-primary has-checked:bg-primary/6 has-checked:ring-1 has-checked:ring-inset has-checked:ring-primary has-focus-visible:ring-2 has-focus-visible:ring-inset has-focus-visible:ring-ring"
            >
              <input
                type="radio"
                name="kind-of-work"
                value={option.id}
                checked={role === option.id}
                onChange={() => onSelect(option.id)}
                className="sr-only"
              />
              <span className="grid size-[34px] place-items-center rounded-lg bg-primary/8 text-primary [&_svg]:size-4.5">
                {ROLE_ICONS[option.id]}
              </span>
              <span className="mt-2.5 block text-base font-semibold text-foreground">
                {option.title}
              </span>
              <span className="text-sm text-muted-foreground">{option.description}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-8">
        <Button size="xl" disabled={role === null} onClick={onNext}>
          Continue
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ task */

function TaskStep({
  role,
  microsoft,
  google,
  onBack,
  onPick,
}: {
  readonly role: OnboardingRole;
  readonly microsoft: IntegrationConnection;
  readonly google: IntegrationConnection;
  readonly onBack: () => void;
  readonly onPick: (task: OnboardingTask) => void;
}) {
  const loading = microsoft.status === "loading" || google.status === "loading";
  const microsoftAvailable = microsoft.status !== "unavailable" && microsoft.status !== "loading";
  const googleAvailable = google.status !== "unavailable" && google.status !== "loading";
  const recommended = recommendedTaskId(
    role,
    microsoft.status === "connected" ||
      (!taskNeedsMicrosoft(role.tasks[0]) && google.status === "connected"),
  );
  const available = (task: OnboardingTask) =>
    !taskNeedsAccount(task) ||
    (taskNeedsMicrosoft(task) ? microsoftAvailable : microsoftAvailable || googleAvailable);
  return (
    <div className="mx-auto w-full max-w-[660px]">
      <BackButton onClick={onBack} />
      <StepHeading eyebrow="Step 2 of 3" title="Pick something to try first.">
        Picked for {role.id === "other" ? "a mix of work" : role.title.toLowerCase()}. Each one is
        real work, and we'll only set up what it needs.
      </StepHeading>
      <div className="mt-8 grid gap-2.5">
        {role.tasks.map((task) => {
          const checking = loading && taskNeedsAccount(task);
          const enabled = !taskNeedsAccount(task) || (!loading && available(task));
          return (
            <button
              key={task.id}
              type="button"
              disabled={!enabled}
              onClick={() => onPick(task)}
              className="group flex w-full items-center gap-4 rounded-2xl border border-border bg-card px-4.5 py-4 text-left outline-none transition-[border-color,box-shadow] duration-200 enabled:hover:border-primary/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-55"
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/8 text-primary [&_svg]:size-[18px]">
                {taskIcon(task)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-semibold text-foreground">{task.title}</span>
                  {task.id === recommended && !loading ? (
                    <Badge variant="info" size="sm">
                      Recommended
                    </Badge>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-sm text-muted-foreground">
                  {checking
                    ? "Checking which accounts can connect…"
                    : enabled
                      ? taskUses(task)
                      : "Email and calendar aren't set up in this copy of TritonAI yet"}
                </span>
              </span>
              <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground/60" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ connect */

const SIGN_IN_HELP: ReadonlyArray<{
  readonly question: string;
  readonly answer: (company: string) => string;
}> = [
  {
    question: "I signed in with the wrong account",
    answer: (company) =>
      `Close ${company}'s page and choose Start over. When ${company} asks which account to use, pick your UC San Diego one.`,
  },
  {
    question: "It says I need an admin's approval",
    answer: () =>
      "Your department may not have approved TritonAI for this yet. Try a file instead for now, and ask your IT team about it.",
  },
  {
    question: "I closed the page or clicked Cancel",
    answer: () => "No problem. Choose Start over and the sign-in page opens again.",
  },
];

function SignInHelp({ company }: { readonly company: string }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="mt-4 grid justify-items-start gap-0.5 border-t border-border/70 pt-3">
      {SIGN_IN_HELP.map((item, index) => (
        <div key={item.question} className="w-full">
          <Button
            variant="link"
            size="sm"
            aria-expanded={open === index}
            onClick={() => setOpen(open === index ? null : index)}
          >
            {item.question}
          </Button>
          {open === index ? (
            <p className="guided-onboarding-pop mb-1.5 rounded-lg bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
              {item.answer(company)}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function StepNumber({ n }: { readonly n: number }) {
  return (
    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
      {n}
    </span>
  );
}

function SignInProgress({
  provider,
  connection,
}: {
  readonly provider: OnboardingMailProvider;
  readonly connection: IntegrationConnection;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "sign-in code" });
  const company = PROVIDER_COMPANY[provider];
  const flow = connection.flow;
  const signInUrl =
    flow?.kind === "device_code"
      ? (flow.verificationUriComplete ?? flow.verificationUri)
      : flow?.kind === "authorization_url"
        ? flow.authorizationUrl
        : null;
  const hasCode = flow?.kind === "device_code";
  return (
    <div className="guided-onboarding-pop mt-4 rounded-2xl border border-primary/25 bg-primary/4 p-5">
      <div className="flex items-center gap-2.5 text-base font-semibold text-foreground">
        <Spinner size="md" />
        Waiting for you to finish signing in on {company}'s page
      </div>
      <ol className="mt-4 grid gap-3 text-sm text-foreground">
        {hasCode ? (
          <li className="flex items-start gap-3">
            <StepNumber n={1} />
            <div className="min-w-0 flex-1">
              Enter this code on that page:
              <div className="mt-2 flex flex-wrap items-center gap-2.5">
                <code className="select-all rounded-xl border border-border bg-background px-4 py-2 font-mono text-2xl font-semibold tracking-widest">
                  {flow.userCode}
                </code>
                <Button variant="outline" onClick={() => copyToClipboard(flow.userCode, undefined)}>
                  <CopyIcon />
                  {isCopied ? "Copied" : "Copy code"}
                </Button>
              </div>
            </div>
          </li>
        ) : null}
        <li className="flex items-start gap-3">
          <StepNumber n={hasCode ? 2 : 1} />
          <span className="pt-0.5">
            Sign in with your <b className="font-semibold">UC San Diego</b> account.
          </span>
        </li>
        <li className="flex items-start gap-3">
          <StepNumber n={hasCode ? 3 : 2} />
          <span className="pt-0.5">
            {company} lists what TritonAI is asking for. Check it matches the list above, then
            choose{" "}
            <b className="font-semibold">{provider === MICROSOFT_365_ID ? "Accept" : "Allow"}</b>.
          </span>
        </li>
      </ol>
      <p className="mt-4 text-sm text-muted-foreground">
        Come back here when you're done. This page updates by itself.
      </p>
      {signInUrl ? (
        <div className="mt-2">
          <Button
            variant="link"
            size="sm"
            render={<a href={signInUrl} target="_blank" rel="noopener noreferrer" />}
          >
            Didn't open? Open {company}'s sign-in page
            <ExternalLinkIcon />
          </Button>
        </div>
      ) : null}
      <SignInHelp company={company} />
    </div>
  );
}

function ConnectionAccessList({
  connection,
  connected,
}: {
  readonly connection: IntegrationConnection;
  readonly connected: boolean;
}) {
  const access = connectionAccess(connection.integration);
  if (access.reads.length === 0 && access.writes.length === 0) return null;
  return (
    <div className="mt-4 rounded-xl bg-muted/50 px-4 py-3 text-sm">
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {connected ? "It can" : "Signing in lets it"}
      </p>
      <ul className="grid gap-1 text-foreground">
        {access.reads.map((permission) => (
          <li key={permission} className="flex items-center gap-2">
            <CheckIcon className="size-3.5 text-success-foreground" strokeWidth={3} />
            {permission}
          </li>
        ))}
      </ul>
      {access.writes.length > 0 ? (
        <p className="mt-2 text-muted-foreground">
          It can also {access.writes.map((name) => name.toLowerCase()).join(", ")}, because those
          are turned on in Settings → Plugins. In this conversation it asks you before each one.
        </p>
      ) : (
        <p className="mt-2 text-muted-foreground">
          It can only read. It can't send email, and saving drafts or changing anything is a
          separate option in Settings → Plugins.
        </p>
      )}
    </div>
  );
}

function ConnectStep({
  task,
  provider,
  microsoft,
  google,
  onProvider,
  onBack,
  onRun,
  onUseFile,
  running,
  runError,
}: {
  readonly task: OnboardingTask;
  readonly provider: OnboardingMailProvider;
  readonly microsoft: IntegrationConnection;
  readonly google: IntegrationConnection;
  readonly onProvider: (provider: OnboardingMailProvider) => void;
  readonly onBack: () => void;
  readonly onRun: () => void;
  readonly onUseFile: () => void;
  readonly running: boolean;
  readonly runError: string | null;
}) {
  const connection = provider === GOOGLE_WORKSPACE_ID ? google : microsoft;
  const other: OnboardingMailProvider =
    provider === GOOGLE_WORKSPACE_ID ? MICROSOFT_365_ID : GOOGLE_WORKSPACE_ID;
  const otherConnection = other === GOOGLE_WORKSPACE_ID ? google : microsoft;
  const canSwitch =
    !taskNeedsMicrosoft(task) &&
    otherConnection.status !== "unavailable" &&
    otherConnection.status !== "loading";
  const company = PROVIDER_COMPANY[provider];
  const thing =
    task.source === "calendar" ? "calendar" : task.source === "teams" ? "Teams chats" : "email";
  const status = connection.status;
  const connected = status === "connected";
  const busy = status === "loading" || status === "starting";

  return (
    <div className="mx-auto w-full max-w-[660px]">
      <BackButton onClick={onBack} />
      <StepHeading
        eyebrow="Step 3 of 3 · Connect"
        title={connected ? "You're connected." : `Connect your ${thing}.`}
      >
        {connected
          ? `TritonAI can read your ${thing} when you ask it something.`
          : `To ${task.title.charAt(0).toLowerCase()}${task.title.slice(1)}, TritonAI needs to read your ${thing}. You'll sign in on ${company}'s own page.`}
      </StepHeading>

      <div className="mt-8 rounded-2xl border border-border bg-card p-5 shadow-lg/5">
        <div className="flex items-center gap-3.5">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-muted/70">
            <ProviderLogo provider={provider} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold text-foreground">{PROVIDER_TITLE[provider]}</p>
            <p className="truncate text-sm text-muted-foreground">
              {connected
                ? connection.integration?.accountLabel
                  ? `Connected as ${connection.integration.accountLabel}`
                  : `Connected to your UC San Diego ${PROVIDER_ACCOUNT[provider]} account`
                : `Your UC San Diego ${PROVIDER_ACCOUNT[provider]} account`}
            </p>
          </div>
          {connected ? (
            <Badge variant="success">
              <CheckIcon />
              Connected
            </Badge>
          ) : null}
        </div>

        {status === "unavailable" ? (
          <p className="mt-4 rounded-xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground">
            {accountName(provider)} isn't set up in this copy of TritonAI yet.
          </p>
        ) : (
          <ConnectionAccessList connection={connection} connected={connected} />
        )}

        {status === "waiting" ? (
          <SignInProgress provider={provider} connection={connection} />
        ) : null}

        {status === "failed" && connection.error ? <ErrorText>{connection.error}</ErrorText> : null}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {connected ? (
            <Button size="xl" disabled={running} onClick={onRun}>
              {running ? <Spinner /> : null}
              {task.action}
              <ArrowRightIcon />
            </Button>
          ) : status === "waiting" ? (
            <Button variant="outline" size="lg" onClick={() => void connection.connect()}>
              Start over
            </Button>
          ) : status !== "unavailable" ? (
            <Button size="xl" disabled={busy} onClick={() => void connection.connect()}>
              {busy ? <Spinner /> : <ProviderLogo provider={provider} className="size-4.5" />}
              {status === "failed" ? "Try again" : `Connect ${accountName(provider)}`}
            </Button>
          ) : null}
          {!connected && canSwitch && status !== "waiting" ? (
            <Button variant="ghost-muted" onClick={() => onProvider(other)}>
              Use {accountName(other)} instead
            </Button>
          ) : null}
        </div>
        {runError ? <ErrorText>{runError}</ErrorText> : null}
      </div>

      <FinePrint>
        Your sign-in stays on the computer running TritonAI, and you can disconnect anytime in
        Settings → Plugins. When you ask something, what it reads from your {thing} is sent to the
        AI model so it can answer.
      </FinePrint>
      {!connected ? (
        <div className="mt-6">
          <Button variant="ghost-muted" onClick={onUseFile}>
            Not now. Try it on a file instead
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ file */

function SamplePreview({ task }: { readonly task: OnboardingTask }) {
  const sample = task.sample;
  if (!sample) return null;
  const rows = sample.table ? parseSampleTable(sample.contents) : [];
  return (
    <div className="overflow-hidden rounded-xl border border-border/70">
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/50 px-3.5 py-2 text-xs text-muted-foreground">
        <FileTextIcon className="size-3.5" />
        {sample.fileName}
      </div>
      {sample.table ? (
        <table className="w-full text-sm">
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={row.join("|")} className="border-b border-border/50 last:border-0">
                {row.map((cell, cellIndex) => {
                  const Cell = rowIndex === 0 ? "th" : "td";
                  const numeric = cellIndex > 0 && rowIndex > 0;
                  return (
                    <Cell
                      key={rows[0]?.[cellIndex] ?? cell}
                      className={cn(
                        "px-3.5 py-1.5",
                        cellIndex > 0 ? "text-right tabular-nums" : "text-left",
                        rowIndex === 0
                          ? "text-xs font-semibold text-muted-foreground"
                          : "text-foreground",
                      )}
                    >
                      {numeric ? `$${Number(cell).toLocaleString()}` : cell}
                    </Cell>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <pre className="max-h-[168px] overflow-hidden whitespace-pre-wrap px-3.5 py-3 font-mono text-xs leading-relaxed text-muted-foreground">
          {sample.contents}
        </pre>
      )}
    </div>
  );
}

function FileStep({
  task,
  onBack,
  onSample,
  onOwnFile,
  running,
  runError,
}: {
  readonly task: OnboardingTask;
  readonly onBack: () => void;
  readonly onSample: () => void;
  readonly onOwnFile: (file: File) => void;
  readonly running: boolean;
  readonly runError: string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) onOwnFile(file);
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file && !running) onOwnFile(file);
  };
  return (
    <div className="mx-auto w-full max-w-[860px]">
      <BackButton onClick={onBack} />
      <StepHeading eyebrow="Step 3 of 3 · Pick a file" title={task.fileQuestion ?? "Which file?"}>
        Use our sample, or one of your own. Both get a real answer. The sample just saves you
        looking for one.
      </StepHeading>
      <div className="mt-8 grid gap-3.5 md:grid-cols-[1.2fr_1fr]">
        <div className="flex flex-col gap-3.5 rounded-2xl border border-border bg-card p-5 shadow-lg/5">
          <div>
            <p className="text-base font-semibold text-foreground">Use a sample</p>
            <p className="text-sm text-muted-foreground">
              Made up, but just like a real one. It goes into your message as text.
            </p>
          </div>
          <SamplePreview task={task} />
          <Button size="xl" className="mt-auto w-full" disabled={running} onClick={onSample}>
            {running ? <Spinner /> : null}
            {task.action} with the sample
          </Button>
        </div>
        <div className="flex flex-col gap-3.5 rounded-2xl border border-border bg-card p-5 shadow-lg/5">
          <div>
            <p className="text-base font-semibold text-foreground">Use my own file</p>
            <p className="text-sm text-muted-foreground">
              Word, Excel, PDF or text. It reads the file and won't change it.
            </p>
          </div>
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={drop}
            className={cn(
              "grid flex-1 place-items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center text-sm text-muted-foreground transition-colors",
              dragging ? "border-primary bg-primary/5 text-primary" : "border-border",
            )}
          >
            <FolderOpenIcon className="size-6" />
            Drag a file here
          </div>
          <input ref={inputRef} type="file" className="hidden" onChange={pick} />
          <Button
            variant="outline"
            size="xl"
            className="w-full"
            disabled={running}
            onClick={() => inputRef.current?.click()}
          >
            Choose a file…
          </Button>
        </div>
      </div>
      {runError ? <ErrorText>{runError}</ErrorText> : null}
      <FinePrint>
        Only the file you pick is used. To answer, its contents are sent to the AI model. If it
        needs to run a program to open the file, it asks you first.
      </FinePrint>
    </div>
  );
}

/* ------------------------------------------------------------------ tour */

const PROGRESS_INDEX: Record<GuidedTourStep, number> = {
  welcome: 0,
  role: 1,
  task: 2,
  connect: 3,
  file: 3,
};

export function GuidedOnboarding() {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const ensureProject = useTritonAiProject(environmentId);
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const tour = useGuidedTourState();
  const { step, roleId, taskId } = tour;
  const role = onboardingRole(roleId);
  const task = onboardingTask(role, taskId) ?? role.tasks[0];
  const mainRef = useRef<HTMLElement>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const sending = useRef(false);
  // Owned here, not by the Connect step, so a sign-in finishes even after Back.
  const microsoft = useIntegrationConnection(MICROSOFT_365_ID, environmentId);
  const google = useIntegrationConnection(GOOGLE_WORKSPACE_ID, environmentId);

  // Moving to a step puts focus at the top of the new step for keyboard and screen readers.
  const goTo = useCallback((next: GuidedTourStep) => {
    setRunError(null);
    updateGuidedTourState({ step: next });
    mainRef.current?.focus();
  }, []);

  const exit = useCallback(() => {
    void navigate({ to: "/settings/general" });
  }, [navigate]);

  const provider: OnboardingMailProvider =
    task.source === "teams"
      ? MICROSOFT_365_ID
      : (tour.provider ??
        (microsoft.status === "unavailable" && google.status !== "unavailable"
          ? GOOGLE_WORKSPACE_ID
          : MICROSOFT_365_ID));

  const pickTask = (picked: OnboardingTask) => {
    updateGuidedTourState({ taskId: picked.id });
    goTo(picked.source === "file" ? "file" : "connect");
  };

  /**
   * Start the first task in a new conversation in the TritonAI folder and go straight to
   * it, so the answer and the follow-ups live in the real chat rather than in the tour.
   */
  const run = async (input: {
    readonly text: string;
    readonly attach?: () => Promise<{ attachment: ChatAttachment; release: () => void }>;
    readonly provider?: OnboardingMailProvider | null;
  }) => {
    if (!environmentId || sending.current) return;
    sending.current = true;
    setRunning(true);
    setRunError(null);
    let release = () => {};
    try {
      const project = await ensureProject();
      if (!project) throw new Error("Couldn't open your TritonAI folder. Try again.");
      const serverConfig = serverConfigs.get(environmentId);
      const projectSettings = resolveProjectSettings(
        serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
        project.id,
        project,
      ).settings;
      const drafts = useComposerDraftStore.getState();
      // The same model a new conversation here would start with.
      const modelSelection = resolveDefaultProviderModelSelection(
        serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS,
        projectSettings.defaultModelSelection ??
          (drafts.stickyActiveProvider
            ? (drafts.stickyModelSelectionByProvider[drafts.stickyActiveProvider] ?? null)
            : null),
      );
      if (!modelSelection) {
        throw new Error("TritonAI needs an AI model set up first. Check Settings → Runtime.");
      }
      const attached = input.attach ? await input.attach() : null;
      if (attached) release = attached.release;
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const started = await startTurn({
        environmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: input.text,
            attachments: attached ? [attached.attachment] : [],
          },
          modelSelection,
          titleSeed: task.title,
          runtimeMode: TOUR_RUNTIME_MODE,
          interactionMode: "default",
          bootstrap: {
            createThread: {
              projectId: project.id,
              title: task.title,
              modelSelection,
              runtimeMode: TOUR_RUNTIME_MODE,
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt,
            },
          },
        },
      });
      release();
      release = () => {};
      if (started._tag === "Failure") throw new Error("The assistant couldn't start. Try again.");
      updateGuidedTourState({
        taskEnvironmentId: environmentId,
        taskThreadId: threadId,
        provider: input.provider ?? null,
        usedFollowUps: [],
        chatGuideDismissed: false,
      });
      const threadRef = scopeThreadRef(environmentId, threadId);
      // The chat route treats a conversation it hasn't received yet as missing.
      await waitForThreadShell(threadRef).catch(() => false);
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        replace: true,
      });
    } catch (cause) {
      release();
      setRunError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
    } finally {
      sending.current = false;
      setRunning(false);
    }
  };

  const fileTask = task.source === "file" ? task : role.tasks[1];
  const runSample = () => void run({ text: fileTaskMessage(fileTask, { sample: true }) });
  const runOwnFile = (file: File) => {
    if (!environmentId) return;
    void run({
      text: fileTaskMessage(fileTask, { attachedFileName: file.name || "file" }),
      attach: () => attachOwnFile(environmentId, file),
    });
  };
  const runConnected = () => void run({ text: accountTaskMessage(task, provider), provider });

  const progressIndex = PROGRESS_INDEX[step];

  // A modal over the app: focus stays in the tour and the sidebar behind it is inert.
  // Escape is ignored so a stray key never throws away progress; Exit tour leaves.
  return (
    <DialogPrimitive.Root
      open
      modal
      disablePointerDismissal
      onOpenChange={(_, event) => event.cancel()}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Popup
          aria-label="Guided tour"
          initialFocus={mainRef}
          className="fixed inset-0 z-60 flex flex-col overflow-y-auto bg-background outline-none"
        >
          <div aria-hidden="true" className="guided-onboarding-glow" />
          <header className="relative grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-5 py-4 sm:px-8 sm:py-5">
            <div className="flex min-w-0 items-center gap-2.5 font-semibold text-foreground">
              <img src="/tritonai-logo.png" alt="" className="size-7 rounded-lg" />
              <span className="hidden sm:inline">TritonAI</span>
              <Badge variant="warning" size="sm">
                Experimental
              </Badge>
            </div>
            <div
              className="flex gap-1.5"
              role="progressbar"
              aria-label="Tour progress"
              aria-valuemin={0}
              aria-valuemax={3}
              aria-valuenow={progressIndex}
            >
              {[1, 2, 3].map((index) => (
                <span
                  key={index}
                  className={cn(
                    "h-1 w-7 rounded-full transition-colors duration-500",
                    index <= progressIndex ? "bg-primary" : "bg-border",
                  )}
                />
              ))}
            </div>
            <div className="flex justify-end">
              <Button variant="ghost-muted" size="sm" onClick={exit}>
                Exit tour
              </Button>
            </div>
          </header>
          <main
            ref={mainRef}
            tabIndex={-1}
            className="relative grid flex-1 place-items-center px-5 pt-2 pb-14 outline-none sm:px-8"
          >
            <div key={step} className="guided-onboarding-step w-full">
              {step === "welcome" ? <WelcomeStep onNext={() => goTo("role")} /> : null}
              {step === "role" ? (
                <RoleStep
                  role={roleId}
                  onSelect={(next) => updateGuidedTourState({ roleId: next })}
                  onBack={() => goTo("welcome")}
                  onNext={() => goTo("task")}
                />
              ) : null}
              {step === "task" ? (
                <TaskStep
                  role={role}
                  microsoft={microsoft}
                  google={google}
                  onBack={() => goTo("role")}
                  onPick={pickTask}
                />
              ) : null}
              {step === "connect" ? (
                <ConnectStep
                  task={task}
                  provider={provider}
                  microsoft={microsoft}
                  google={google}
                  onProvider={(next) => updateGuidedTourState({ provider: next })}
                  onBack={() => goTo("task")}
                  onRun={runConnected}
                  onUseFile={() => {
                    updateGuidedTourState({ taskId: role.tasks[1].id });
                    goTo("file");
                  }}
                  running={running}
                  runError={runError}
                />
              ) : null}
              {step === "file" ? (
                <FileStep
                  task={fileTask}
                  onBack={() => goTo("task")}
                  onSample={runSample}
                  onOwnFile={runOwnFile}
                  running={running}
                  runError={runError}
                />
              ) : null}
            </div>
          </main>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
