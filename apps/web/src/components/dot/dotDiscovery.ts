/** Public discovery metadata from the bot's optional `/state` fields. */
export type DotCapabilityAvailability =
  | { readonly status: "available" }
  | { readonly status: "needs-connection"; readonly how: string }
  | { readonly status: "not-available-for-account"; readonly why: string };

export interface DotCapability {
  readonly id: string;
  readonly description: string;
  readonly examples: readonly string[];
  readonly availability: DotCapabilityAvailability;
}

export type DotMicrosoftArea = "calendar" | "attention" | "mail-actions" | "onedrive" | "todo";

export interface DotMicrosoftAreaHealth {
  readonly status: "connected" | "needs-reconnect" | "degraded";
  readonly since: string;
  readonly lastSuccess?: string;
  readonly lastFailureCode?: string;
  readonly generation: string;
}

export interface DotMicrosoftHealth {
  readonly userId: string;
  readonly version: number;
  readonly generation: string;
  readonly areas: Partial<Readonly<Record<DotMicrosoftArea, DotMicrosoftAreaHealth>>>;
  readonly emailGeneration?: string;
  readonly outageSince?: string;
  readonly recovery?: {
    readonly previousGeneration: string;
    readonly outageSince: string;
    readonly status: "pending" | "resumed" | "unconfirmed";
    readonly resumed: readonly string[];
    readonly notContinued: readonly string[];
  };
}

export interface DotMicrosoftState {
  /** Older pilot services report account eligibility without connection health. */
  readonly available?: boolean;
  readonly message?: string;
  readonly health?: DotMicrosoftHealth;
}
