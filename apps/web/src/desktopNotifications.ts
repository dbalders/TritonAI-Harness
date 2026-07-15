import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, OrchestrationSessionStatus, ThreadId } from "@t3tools/contracts";

export const MAX_DESKTOP_NOTIFICATIONS_PER_UPDATE = 3;

export interface DesktopNotificationThreadShellLike {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly title: string;
  readonly archivedAt: string | null;
  readonly session: { readonly status: OrchestrationSessionStatus } | null;
  readonly latestTurn: {
    readonly state: "running" | "interrupted" | "completed" | "error";
  } | null;
  readonly hasPendingApprovals: boolean;
  readonly hasActionableProposedPlan: boolean;
  readonly hasPendingUserInput: boolean;
}

export type DesktopNotificationKind = "completed" | "failed" | "approval" | "input";

export interface DesktopNotificationIntent {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly kind: DesktopNotificationKind;
}

export type DesktopNotificationDelivery =
  | { readonly type: "thread"; readonly intent: DesktopNotificationIntent }
  | { readonly type: "summary"; readonly count: number };

export type DesktopNotificationThreadMap = ReadonlyMap<string, DesktopNotificationThreadShellLike>;

export type DesktopNotificationPermission = NotificationPermission | "unsupported";

export interface DesktopNotificationObservation {
  readonly baseline: DesktopNotificationThreadMap;
  readonly intents: ReadonlyArray<DesktopNotificationIntent>;
}

function isActiveSessionStatus(status: OrchestrationSessionStatus | null): boolean {
  return status === "running" || status === "starting";
}

function notificationKindForStoppedThread(
  thread: DesktopNotificationThreadShellLike,
): DesktopNotificationKind | null {
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return "failed";
  }
  if (
    thread.session?.status === "interrupted" ||
    thread.session?.status === "stopped" ||
    thread.latestTurn?.state === "interrupted"
  ) {
    return null;
  }
  return "completed";
}

function intentForThread(
  thread: DesktopNotificationThreadShellLike,
  kind: DesktopNotificationKind,
): DesktopNotificationIntent {
  return {
    environmentId: thread.environmentId,
    threadId: thread.id,
    threadTitle: thread.title,
    kind,
  };
}

export function makeDesktopNotificationThreadMap(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): DesktopNotificationThreadMap {
  return new Map(
    threads.map((thread) => [
      scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id }),
      thread,
    ]),
  );
}

/**
 * Detect user-relevant rising edges without participating in orchestration.
 * Missing previous shells are treated as bootstrap/reseed state and never notify.
 */
export function deriveDesktopNotificationIntents(
  previous: DesktopNotificationThreadMap,
  next: DesktopNotificationThreadMap,
): DesktopNotificationIntent[] {
  const intents: DesktopNotificationIntent[] = [];

  for (const [key, nextThread] of next) {
    if (nextThread.archivedAt !== null) {
      continue;
    }

    const previousThread = previous.get(key);
    if (!previousThread) {
      continue;
    }

    const previousApproval =
      previousThread.hasPendingApprovals || previousThread.hasActionableProposedPlan;
    const nextApproval = nextThread.hasPendingApprovals || nextThread.hasActionableProposedPlan;
    if (!previousApproval && nextApproval) {
      intents.push(intentForThread(nextThread, "approval"));
      continue;
    }

    if (!previousThread.hasPendingUserInput && nextThread.hasPendingUserInput) {
      intents.push(intentForThread(nextThread, "input"));
      continue;
    }

    const previousStatus = previousThread.session?.status ?? null;
    const nextStatus = nextThread.session?.status ?? null;
    if (isActiveSessionStatus(previousStatus) && !isActiveSessionStatus(nextStatus)) {
      const kind = notificationKindForStoppedThread(nextThread);
      if (kind) {
        intents.push(intentForThread(nextThread, kind));
      }
    }
  }

  return intents;
}

/**
 * Advance the baseline even while notifications are disabled. This prevents
 * enabling the setting later from replaying work that already finished.
 */
export function observeDesktopNotificationThreads(
  previous: DesktopNotificationThreadMap | null,
  next: DesktopNotificationThreadMap,
  enabled: boolean,
): DesktopNotificationObservation {
  return {
    baseline: next,
    intents: enabled && previous !== null ? deriveDesktopNotificationIntents(previous, next) : [],
  };
}

export function planDesktopNotificationDeliveries(
  intents: ReadonlyArray<DesktopNotificationIntent>,
): ReadonlyArray<DesktopNotificationDelivery> {
  if (intents.length > MAX_DESKTOP_NOTIFICATIONS_PER_UPDATE) {
    return [{ type: "summary", count: intents.length }];
  }
  return intents.map((intent) => ({ type: "thread", intent }));
}

export function getDesktopNotificationPermission(): DesktopNotificationPermission {
  if (typeof Notification === "undefined") {
    return "unsupported";
  }
  return Notification.permission;
}

export async function requestDesktopNotificationPermission(): Promise<DesktopNotificationPermission> {
  if (typeof Notification === "undefined") {
    return "unsupported";
  }
  if (Notification.permission !== "default") {
    return Notification.permission;
  }
  return Notification.requestPermission();
}

export function isHarnessInBackground(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return document.visibilityState !== "visible" || !document.hasFocus();
}

export function desktopNotificationContent(intent: DesktopNotificationIntent): {
  readonly title: string;
  readonly body: string;
} {
  switch (intent.kind) {
    case "completed":
      return { title: "Task finished", body: `${intent.threadTitle} is ready to review.` };
    case "failed":
      return { title: "Task failed", body: `${intent.threadTitle} needs attention.` };
    case "approval":
      return { title: "Approval needed", body: `${intent.threadTitle} is waiting for approval.` };
    case "input":
      return {
        title: "Your input is needed",
        body: `${intent.threadTitle} is waiting for your answer.`,
      };
  }
}

export function desktopNotificationSummaryContent(count: number): {
  readonly title: string;
  readonly body: string;
} {
  return {
    title: "Several tasks need attention",
    body: `${count} tasks finished or are waiting for you.`,
  };
}

function createDesktopNotification(
  title: string,
  options: NotificationOptions,
  onClick?: () => void,
): boolean {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return false;
  }

  const notification = new Notification(title, { ...options, silent: true });
  if (onClick) {
    notification.addEventListener("click", () => {
      notification.close();
      window.focus();
      onClick();
    });
  }
  return true;
}

export function showDesktopNotification(
  intent: DesktopNotificationIntent,
  onClick: () => void,
): boolean {
  const content = desktopNotificationContent(intent);
  return createDesktopNotification(
    content.title,
    {
      body: content.body,
      tag: scopedThreadKey({ environmentId: intent.environmentId, threadId: intent.threadId }),
    },
    onClick,
  );
}

export function showDesktopNotificationSummary(count: number, onClick: () => void): boolean {
  const content = desktopNotificationSummaryContent(count);
  return createDesktopNotification(
    content.title,
    {
      body: content.body,
      tag: "tritonai-desktop-notification-summary",
    },
    onClick,
  );
}

export function showTestDesktopNotification(): boolean {
  return createDesktopNotification("Desktop notifications are on", {
    body: "TritonAI Harness will notify you when a background task needs attention.",
    tag: "tritonai-desktop-notification-test",
  });
}
