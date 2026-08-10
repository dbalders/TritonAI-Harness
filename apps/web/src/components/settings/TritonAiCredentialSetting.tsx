import type { DesktopTritonAiCredentialStatus } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";

const EMPTY_STATUS: DesktopTritonAiCredentialStatus = {
  ready: false,
  usesSharedKey: false,
  onPremConfigured: false,
  frontierConfigured: false,
};

function AccessStatusRow({
  label,
  examples,
  configured,
  ready,
}: {
  label: string;
  examples: string;
  configured: boolean;
  ready: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">{label}</p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground/75">{examples}</p>
      </div>
      <Badge variant={ready && configured ? "success" : "secondary"} size="sm">
        {ready ? (configured ? "Configured" : "Not configured") : "Checking…"}
      </Badge>
    </div>
  );
}

export function TritonAiCredentialSetting() {
  const desktopBridge = window.desktopBridge;
  const [credentials, setCredentials] = useState(EMPTY_STATUS);
  const [primaryApiKey, setPrimaryApiKey] = useState("");
  const [secondaryApiKey, setSecondaryApiKey] = useState("");
  const [secondKeyVisible, setSecondKeyVisible] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!desktopBridge) return;
    let cancelled = false;
    void desktopBridge
      .getTritonAiCredentialStatus()
      .then((status) => {
        if (!cancelled) setCredentials(status);
      })
      .catch(() => {
        if (!cancelled) setCredentials(EMPTY_STATUS);
      });
    return () => {
      cancelled = true;
    };
  }, [desktopBridge]);

  if (!desktopBridge) return null;

  const primaryReplacement = primaryApiKey.trim();
  const secondaryReplacement = secondaryApiKey.trim();
  const canSave =
    primaryReplacement.length > 0 &&
    (!secondKeyVisible || secondaryReplacement.length > 0) &&
    !isSaving;

  const saveCredentials = async () => {
    if (!canSave) return;
    setIsSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const result = await desktopBridge.updateTritonAiCredentials([
        primaryReplacement,
        ...(secondKeyVisible ? [secondaryReplacement] : []),
      ]);
      if (result.status === "error") {
        setIsSaving(false);
        setSaveError(result.message);
        return;
      }
      setCredentials(result.credentials);
      setPrimaryApiKey("");
      setSecondaryApiKey("");
      setSecondKeyVisible(false);
      setIsSaving(false);
      setSaveMessage(
        result.credentials.onPremConfigured && result.credentials.frontierConfigured
          ? "Access updated for on-prem and frontier models."
          : result.credentials.onPremConfigured
            ? "Access updated for on-prem models."
            : "Access updated for frontier models.",
      );
    } catch (error) {
      setIsSaving(false);
      setSaveError(
        error instanceof Error
          ? `Desktop request failed: ${error.message}`
          : "The desktop request failed with an unknown error.",
      );
    }
  };

  return (
    <SettingsSection title="TritonAI access">
      <div className="space-y-4 px-4 py-5 sm:px-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-medium text-foreground">Model access on this desktop</h3>
            {credentials.ready && credentials.usesSharedKey ? (
              <Badge variant="secondary" size="sm">
                One key covers both
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground/80">
            Saved keys are never displayed. TritonAI Harness checks new keys and automatically uses
            each one for the model groups it can access.
          </p>
        </div>

        <div className="grid max-w-2xl gap-2 sm:grid-cols-2">
          <AccessStatusRow
            label="On-prem models"
            examples="DeepSeek, GLM, and Gemma"
            configured={credentials.onPremConfigured}
            ready={credentials.ready}
          />
          <AccessStatusRow
            label="Frontier models"
            examples="GPT-5.6 and Claude"
            configured={credentials.frontierConfigured}
            ready={credentials.ready}
          />
        </div>

        <form
          className="max-w-2xl space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void saveCredentials();
          }}
        >
          <div>
            <label htmlFor="tritonai-access-key" className="text-xs font-medium text-foreground">
              New TritonAI access key
            </label>
            <Input
              id="tritonai-access-key"
              className="mt-1.5"
              type="password"
              maxLength={8_192}
              autoComplete="new-password"
              spellCheck={false}
              value={primaryApiKey}
              placeholder="Enter access key"
              disabled={isSaving}
              onChange={(event) => {
                setPrimaryApiKey(event.target.value);
                setSaveError(null);
                setSaveMessage(null);
              }}
            />
          </div>

          {secondKeyVisible ? (
            <div>
              <label
                htmlFor="tritonai-additional-access-key"
                className="text-xs font-medium text-foreground"
              >
                Additional access key
              </label>
              <Input
                id="tritonai-additional-access-key"
                className="mt-1.5"
                type="password"
                maxLength={8_192}
                autoComplete="new-password"
                spellCheck={false}
                value={secondaryApiKey}
                placeholder="Enter additional access key"
                disabled={isSaving}
                onChange={(event) => {
                  setSecondaryApiKey(event.target.value);
                  setSaveError(null);
                  setSaveMessage(null);
                }}
              />
            </div>
          ) : null}

          <p className="text-xs leading-relaxed text-muted-foreground/80">
            {secondKeyVisible
              ? "We’ll detect which key belongs to on-prem and frontier models."
              : "Most people only need one key. Any working key for an unaffected model group is kept."}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!canSave}>
              {isSaving ? "Checking access…" : "Check access & save"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={isSaving}
              onClick={() => {
                setSecondKeyVisible((visible) => {
                  if (visible) setSecondaryApiKey("");
                  return !visible;
                });
                setSaveError(null);
                setSaveMessage(null);
              }}
              aria-expanded={secondKeyVisible}
              aria-controls="tritonai-additional-access-key"
            >
              {secondKeyVisible ? "Use one key" : "I have another access key"}
            </Button>
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            Saving briefly reconnects the local runtime while TritonAI Harness stays open.
          </p>
          {saveError ? (
            <p className="text-xs text-destructive" role="alert">
              {saveError}
            </p>
          ) : null}
          {saveMessage ? (
            <p className="text-xs text-success" role="status">
              {saveMessage}
            </p>
          ) : null}
        </form>
      </div>
    </SettingsSection>
  );
}
