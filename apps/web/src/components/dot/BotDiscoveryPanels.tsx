import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import type { DotCapability, DotMicrosoftArea, DotMicrosoftState } from "./dotDiscovery";

const MICROSOFT_AREA_LABELS: Record<DotMicrosoftArea, string> = {
  calendar: "Calendar",
  attention: "Inbox and direct chats",
  "mail-actions": "Outlook actions",
  onedrive: "OneDrive",
  todo: "Microsoft To Do",
};

export function BotMicrosoftBanner({
  microsoft,
  connectionsUrl,
}: {
  readonly microsoft: DotMicrosoftState | undefined;
  readonly connectionsUrl: string;
}) {
  if (microsoft?.available === false || !microsoft?.health) return null;
  const affected = (Object.keys(MICROSOFT_AREA_LABELS) as DotMicrosoftArea[]).filter(
    (area) => microsoft.health?.areas[area]?.status === "needs-reconnect",
  );
  if (!affected.length) return null;

  return (
    <section
      aria-label="Microsoft connection"
      className="shrink-0 rounded-xl border border-warning/32 bg-warning-surface p-3"
    >
      <div role="status" className="text-sm">
        <p className="font-semibold">Microsoft access needs reconnecting</p>
        <p className="mt-1 text-muted-foreground">
          Needs reconnect: {affected.map((area) => MICROSOFT_AREA_LABELS[area]).join(", ")}.
        </p>
      </div>
      <div className="mt-3">
        <Button
          variant="warning-outline"
          size="sm"
          render={<a href={connectionsUrl} target="_blank" rel="noopener noreferrer" />}
        >
          Reconnect Microsoft
        </Button>
      </div>
    </section>
  );
}

export function BotCapabilitiesPanel({
  capabilities,
  capabilitiesError,
}: {
  readonly capabilities: readonly DotCapability[] | undefined;
  readonly capabilitiesError?: string | undefined;
}) {
  if (capabilities === undefined && !capabilitiesError) return null;

  return (
    <section aria-label="Bot capabilities" className="shrink-0 rounded-xl border p-3">
      {capabilitiesError && (
        <p role="status" className="mb-2 text-sm text-muted-foreground">
          {capabilitiesError}
        </p>
      )}
      {capabilities !== undefined && (
        <details>
          <summary className="cursor-pointer rounded-sm text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
            What I can do
          </summary>
          <div className="mt-3 max-h-64 overflow-y-auto">
            {capabilities.length ? (
              <ul className="space-y-4">
                {capabilities.map((capability) => (
                  <li key={capability.id} className="space-y-2 text-sm">
                    <p>{capability.description}</p>
                    <Badge
                      variant={
                        capability.availability.status === "available"
                          ? "success"
                          : capability.availability.status === "needs-connection"
                            ? "warning"
                            : "secondary"
                      }
                      size="sm"
                    >
                      {capability.availability.status === "available"
                        ? "Available"
                        : capability.availability.status === "needs-connection"
                          ? "Needs connection"
                          : "Not available for your account"}
                    </Badge>
                    {capability.availability.status === "needs-connection" && (
                      <p className="text-muted-foreground">{capability.availability.how}</p>
                    )}
                    {capability.availability.status === "not-available-for-account" && (
                      <p className="text-muted-foreground">{capability.availability.why}</p>
                    )}
                    {capability.examples.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground">Example prompts</p>
                        <ul className="mt-1 list-disc space-y-1 ps-5">
                          {capability.examples.map((example) => (
                            <li key={example}>{example}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No capabilities reported.</p>
            )}
          </div>
        </details>
      )}
    </section>
  );
}
