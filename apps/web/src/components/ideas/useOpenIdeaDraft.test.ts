import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, type Idea, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useOpenIdeaDraft } from "./useOpenIdeaDraft";

const navigation = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigation }));
vi.mock("../../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => async () => ({ draftId: "idea-draft", threadId: "idea-thread" }),
}));
vi.mock("../../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ scratchEnvironmentId: () => null }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [{ environmentId: "idea-environment", id: "idea-project" }],
}));
vi.mock("../../hooks/useSettings", () => ({
  getClientSettings: () => ({ gettingStarted: { startedAt: null } }),
}));

const environmentId = EnvironmentId.make("idea-environment");
const draftId = DraftId.make("idea-draft");
const threadId = ThreadId.make("idea-thread");
const idea = (resume: boolean) =>
  ({
    action: resume
      ? { kind: "resume-thread", threadId, prompt: "UNTRUSTED GENERATED PROMPT" }
      : {
          kind: "new-thread",
          projectId: ProjectId.make("idea-project"),
          prompt: "UNTRUSTED GENERATED PROMPT",
        },
    draftThreadIds: [],
  }) as unknown as Idea;

it.each([false, true])(
  "withholds generated text until host provenance is saved, including failure (resume=%s)",
  async (resume) => {
    navigation.mockClear();
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
    const target = resume ? scopeThreadRef(environmentId, threadId) : draftId;
    const store = useComposerDraftStore.getState();
    store.setPrompt(target, "User's existing request");
    let release!: (allowed: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const open = useOpenIdeaDraft(environmentId);
    const opening = open(idea(resume), async () => {
      entered();
      return pending;
    });
    await Promise.race([admitted, opening]);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
      "User's existing request",
    );
    release(false);
    expect(await opening).toBeNull();
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
      "User's existing request",
    );
    await open(idea(resume), async () => true);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toContain(
      "UNTRUSTED GENERATED PROMPT",
    );
  },
);
