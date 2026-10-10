/** Public owner-client contract for the optional `GET /state` handling view. */
export type DotHandlingState =
  | "working"
  | "waiting-for-you"
  | "waiting-on-system"
  | "scheduled"
  | "done-unseen"
  | "failed"
  | "uncertain";

export type DotHandlingControl = "stop" | "snooze" | "open" | "review";

export interface DotHandlingItem {
  readonly kind: string;
  readonly id: string;
  readonly title: string;
  readonly state: DotHandlingState;
  /** Opaque source token: send unchanged as `expectedVersion` when stopping. */
  readonly version: string;
  readonly upNext?: { readonly at?: string; readonly what: string };
  readonly lastActivityAt?: string;
  readonly note?: string;
  readonly source?: { readonly label: string; readonly link?: string };
  /** Only offer Stop when the server includes `stop`. */
  readonly controls: readonly DotHandlingControl[];
}

export interface DotHandlingView {
  readonly generatedAt: string;
  readonly seenAt?: string;
  readonly paused: boolean;
  readonly timezone: string;
  readonly upNext?: { readonly at: string; readonly what: string; readonly title: string };
  readonly items: readonly DotHandlingItem[];
  /** These sources are unknown, not empty. */
  readonly unavailable: readonly string[];
}

/** Body of `POST /handling/{kind}/{id}/stop` with `{ expectedVersion: item.version }`. */
export interface DotHandlingStopResult {
  readonly ok: boolean;
  /** A request to stop running Harness work has `stopped: false`. */
  readonly stopped: boolean;
  readonly outcome:
    | "stopped"
    | "already-stopped"
    | "stop-requested"
    | "conflict"
    | "not-stoppable"
    | "not-found";
  readonly kind: string;
  readonly id: string;
  readonly message: string;
}
