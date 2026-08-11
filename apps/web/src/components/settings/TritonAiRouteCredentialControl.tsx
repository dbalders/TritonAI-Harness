import type {
  DesktopTritonAiCredentialRoute,
  DesktopTritonAiCredentialStatus,
} from "@t3tools/contracts";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function TritonAiRouteCredentialControl(props: {
  readonly route: DesktopTritonAiCredentialRoute;
  readonly status: DesktopTritonAiCredentialStatus | null;
  readonly onStatusChange: (status: DesktopTritonAiCredentialStatus) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const desktopBridge = window.desktopBridge;
  if (!desktopBridge) return null;

  const routeLabel = props.route === "on-prem" ? "On-prem" : "Frontier";
  const otherRouteLabel = props.route === "on-prem" ? "frontier" : "on-prem";
  const configured =
    props.status === null || !props.status.ready
      ? null
      : props.route === "on-prem"
        ? props.status.onPremConfigured
        : props.status.frontierConfigured;
  const statusDescription =
    props.status === null || !props.status.ready
      ? "Checking the saved TritonAI access setup."
      : props.status.usesSharedKey
        ? "This key is currently shared with the other TritonAI connection."
        : configured
          ? "This connection uses its own saved TritonAI key."
          : "No TritonAI key is saved for this connection.";

  const save = async () => {
    const replacement = apiKey.trim();
    if (!replacement || isSaving) return;
    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const result = await desktopBridge.updateTritonAiCredentials({
        route: props.route,
        apiKey: replacement,
      });
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      props.onStatusChange(result.credentials);
      setApiKey("");
      setIsEditing(false);
      setMessage(`${routeLabel} access key updated. The ${otherRouteLabel} key was kept.`);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? `Desktop request failed: ${cause.message}`
          : "The desktop request failed with an unknown error.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="rounded-lg border border-border/70 bg-muted/20 px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-xs font-medium text-foreground">Access key</h4>
            <Badge variant={configured ? "success" : "secondary"} size="sm">
              {configured === null ? "Checking…" : configured ? "Configured" : "Not configured"}
            </Badge>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{statusDescription}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={isSaving || configured === null}
          onClick={() => {
            setIsEditing((editing) => !editing);
            setApiKey("");
            setError(null);
            setMessage(null);
          }}
        >
          {isEditing ? "Cancel" : configured ? "Change key" : "Add key"}
        </Button>
      </div>

      {isEditing ? (
        <form
          className="mt-3 space-y-2 border-t border-border/60 pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="block">
            <span className="text-xs font-medium text-foreground">New {routeLabel} access key</span>
            <Input
              className="mt-1.5"
              type="password"
              maxLength={8_192}
              autoComplete="new-password"
              spellCheck={false}
              value={apiKey}
              placeholder="Enter access key"
              disabled={isSaving}
              onChange={(event) => {
                setApiKey(event.target.value);
                setError(null);
                setMessage(null);
              }}
            />
          </label>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            TritonAI will verify access to {props.route} models. Only this connection changes.
          </p>
          <Button type="submit" size="sm" disabled={!apiKey.trim() || isSaving}>
            {isSaving ? "Checking access…" : "Check access & save"}
          </Button>
        </form>
      ) : null}

      {error ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="mt-2 text-xs text-success" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}
