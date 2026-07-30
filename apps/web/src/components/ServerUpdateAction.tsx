import type { EnvironmentId, ServerSelfUpdateCapability } from "@t3tools/contracts";

/**
 * TritonAI Harness keeps the upstream update contract for protocol
 * compatibility, but does not expose public-`t3` install or RPC actions.
 * Desktop-managed servers can still point users at the owning app.
 */
export function ServerUpdateAction({
  selfUpdate,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly selfUpdate: ServerSelfUpdateCapability | null;
  readonly targetVersion: string;
}) {
  return (
    <span className="text-muted-foreground text-xs">
      {selfUpdate === "desktop-managed"
        ? "Update the TritonAI Harness desktop app on that machine to update this server."
        : "Automatic server updates are unavailable in TritonAI Harness."}
    </span>
  );
}
