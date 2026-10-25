import { useEffect, useEffectEvent, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerRespondCommonsApprovalInput } from "@t3tools/contracts";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export function CommonsApprovalDialog(props: { readonly environmentId: EnvironmentId }) {
  const approval = useEnvironmentQuery(
    serverEnvironment.commonsApproval({ environmentId: props.environmentId, input: {} }),
  );
  const respond = useAtomCommand(serverEnvironment.respondCommonsApproval, {
    reportFailure: false,
  });
  const canRespond = useAtomValue(
    serverEnvironment.respondCommonsApproval.permissionAtom(props.environmentId),
  );
  const [respondingTo, setRespondingTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submissionId = approval.data?.submissionId;
  const review = approval.data?.review;

  const send = async (input: ServerRespondCommonsApprovalInput) => {
    setRespondingTo(input.action.type === "respond" ? input.action.requestId : input.submissionId);
    setError(null);
    try {
      const result = await respond({ environmentId: props.environmentId, input });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The sharing decision could not be sent.");
    } finally {
      setRespondingTo(null);
    }
  };
  const cancelOnUnmount = useEffectEvent((id: string, targetEnvironmentId: EnvironmentId) => {
    void respond({
      environmentId: targetEnvironmentId,
      input: { submissionId: id, action: { type: "cancel" } },
    });
  });
  useEffect(
    () => () => {
      if (submissionId !== undefined) cancelOnUnmount(submissionId, props.environmentId);
    },
    [submissionId, props.environmentId],
  );

  const cancel = () => {
    if (submissionId !== undefined) void send({ submissionId, action: { type: "cancel" } });
  };
  const decision = (value: "accept" | "decline") => {
    if (submissionId !== undefined && review)
      void send({
        submissionId,
        action: { type: "respond", requestId: review.requestId, decision: value },
      });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <DialogPopup className="w-full max-w-4xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{review ? "Review sharing write" : "Preparing skill sharing"}</DialogTitle>
          <DialogDescription>
            {review
              ? "Approve only this exact write. Each later write needs a separate decision."
              : "Harness is preparing the next change for your review."}
          </DialogDescription>
        </DialogHeader>
        {review ? (
          <div className="min-h-0 space-y-2">
            <p>
              {review.integrationName} · {review.toolName}
            </p>
            <p>Reported account: {review.accountLabel ?? "Not identified"}</p>
            <pre
              role="region"
              aria-label="Complete sharing request"
              tabIndex={0}
              className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all text-xs"
            >
              {`Connection: ${review.connection}\nSubmitted SHA-256: ${review.submittedDigest}\nEffective SHA-256: ${review.effectiveDigest}\n\n${review.payload}`}
            </pre>
          </div>
        ) : (
          <p role="status">Waiting for the next sharing request…</p>
        )}
        {error || approval.error ? <p role="alert">{error ?? approval.error}</p> : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={!canRespond || submissionId === undefined || respondingTo !== null}
            onClick={cancel}
          >
            Cancel sharing
          </Button>
          {review ? (
            <>
              <Button
                variant="outline"
                disabled={!canRespond || respondingTo !== null}
                onClick={() => decision("decline")}
              >
                Decline
              </Button>
              <Button
                disabled={!canRespond || respondingTo !== null}
                onClick={() => decision("accept")}
              >
                Approve once
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
