import { useNavigate } from "@tanstack/react-router";
import { CircleIcon } from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { readRecordSkillBridge } from "../RecordSkill";
import { Button } from "../ui/button";

/**
 * Opens a new thread with `/record-skill` ready in the composer, so the user
 * can pick the project before starting. Shown only in the desktop app, which
 * can record other apps.
 */
export function RecordSkillButton() {
  const [supported] = useState(() => readRecordSkillBridge() !== null);
  const navigate = useNavigate();
  const { defaultProjectRef, handleNewThread } = useHandleNewThread();
  if (!supported) return null;

  const open = async () => {
    if (!defaultProjectRef) {
      await navigate({ to: "/" });
      return;
    }
    const draft = await handleNewThread(defaultProjectRef);
    if (!draft) return;
    // A reused draft keeps what the user was writing.
    const drafts = useComposerDraftStore.getState();
    if (!drafts.getComposerDraft(draft.draftId)?.prompt.trim()) {
      drafts.setPrompt(draft.draftId, "/record-skill");
    }
  };

  return (
    <Button size="sm" variant="outline" onClick={() => void open()}>
      <CircleIcon className="size-3 fill-destructive text-destructive" />
      Record a New Skill
    </Button>
  );
}
