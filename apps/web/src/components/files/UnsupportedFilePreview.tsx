import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { fileBasename, isHostPath } from "@t3tools/shared/path";
import { useRef, useState } from "react";

import { useAssetUrlRefresh } from "~/assets/assetUrls";
import { downloadMedia } from "~/components/media/mediaContent";
import { Button } from "~/components/ui/button";
import { useFileContextMenu } from "~/fileContextMenu";
import { useRemoteOpenResolution } from "~/remoteOpen";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";

import { workspaceAssetResource } from "./filePreviewMode";

export function UnsupportedFilePreview(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly threadRef: ScopedThreadRef;
  readonly draft: boolean;
}) {
  const remote = useRemoteOpenResolution(props.environmentId);
  const canUseShell = useAtomValue(
    shellEnvironment.openInEditor.permissionAtom(props.environmentId),
  );
  const { canReadFiles } = useFilesystemReadAccess(props.environmentId);
  const fileActions = useFileContextMenu(props.environmentId);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const canOpen =
    remote.isResolved &&
    remote.state.mode === "local-exec" &&
    canUseShell &&
    fileActions.capabilities.canOpenDefault;
  const revealLabel = fileActions.capabilities.revealLabel?.replace(/^Reveal in /, "Show in ");
  const prepareDownload = useAssetUrlRefresh(props.environmentId, {
    ...workspaceAssetResource({
      kind: isHostPath(props.relativePath) ? "media-file" : "workspace-file",
      threadRef: props.threadRef,
      draft: props.draft,
      workspaceRoot: props.cwd,
      absolutePath: props.absolutePath,
    }),
    disposition: "attachment",
  });
  const [pending, setPending] = useState<"open" | "reveal" | "download" | null>(null);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: NonNullable<typeof pending>) => {
    if (inFlight.current || !canReadFiles || (action !== "download" && !canOpen)) return;
    inFlight.current = true;
    setPending(action);
    setError(null);
    try {
      if (action === "download") {
        const url = await prepareDownload();
        if (url === null) {
          setError("Reconnect to this environment and try again.");
        } else {
          await downloadMedia(url, fileBasename(props.relativePath));
        }
      } else {
        const result = await openInEditor({
          environmentId: props.environmentId,
          input: {
            cwd: props.absolutePath,
            editor: "file-manager",
            ...(action === "reveal" ? { reveal: true } : {}),
          },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(
            failure instanceof Error ? failure.message : "Could not open this file. Try again.",
          );
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open this file. Try again.");
    }
    inFlight.current = false;
    setPending(null);
  };

  return (
    <div className="my-auto flex flex-col items-center gap-3 px-6 py-6 text-center">
      <p className="text-sm font-medium">This file can’t be previewed in Harness.</p>
      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
        {canOpen
          ? "Open it in another app to view its contents."
          : "Download it to open it in another app."}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {canOpen ? (
          <>
            <Button
              type="button"
              size="sm"
              disabled={pending !== null || !canReadFiles}
              onClick={() => void run("open")}
            >
              {pending === "open" ? "Opening…" : "Open in default app"}
            </Button>
            {revealLabel ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending !== null || !canReadFiles}
                onClick={() => void run("reveal")}
              >
                {pending === "reveal" ? "Opening…" : revealLabel}
              </Button>
            ) : null}
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={pending !== null || !canReadFiles}
            onClick={() => void run("download")}
          >
            {pending === "download" ? "Preparing download…" : "Download"}
          </Button>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
