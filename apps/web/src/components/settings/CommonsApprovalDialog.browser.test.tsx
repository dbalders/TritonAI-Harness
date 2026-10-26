import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  type ServerCommonsApprovalState,
  type ServerCommonsWriteReview,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { CommonsApprovalDialog } from "./CommonsApprovalDialog";
import "~/index.css";

const state = vi.hoisted(() => ({
  approval: null as Atom.Writable<
    AsyncResult.AsyncResult<ServerCommonsApprovalState | null, Error>
  > | null,
  permission: null as Atom.Writable<boolean> | null,
  respond: vi.fn(),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: {
    commonsApproval: () => state.approval,
    respondCommonsApproval: { permissionAtom: () => state.permission },
  },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.respond }));

const environmentId = EnvironmentId.make("synthetic-environment");
const review = (id: string): ServerCommonsWriteReview => ({
  requestId: id,
  integrationName: "GitHub",
  toolName: "github.contents.put",
  accountLabel: "Synthetic contributor",
  connection: `synthetic-connection-${id}`,
  submittedDigest: `submitted-${id}`,
  effectiveDigest: `effective-${id}`,
  payload: `${"Synthetic source line\n".repeat(400)}${id}: LAST LINE MUST BE REVIEWABLE`,
  expiresAt: Date.now() + 300_000,
});
function setup(initial: Omit<ServerCommonsApprovalState, "reviewId">) {
  state.respond.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.approval = Atom.make<AsyncResult.AsyncResult<ServerCommonsApprovalState | null, Error>>(
    AsyncResult.success({ reviewId: "test-view", ...initial }),
  );
  state.permission = Atom.make(true);
  const registry = AtomRegistry.make();
  return {
    registry,
    ui: () => (
      <RegistryContext value={registry}>
        <CommonsApprovalDialog reviewId="test-view" environmentId={environmentId} />
      </RegistryContext>
    ),
    set: (value: Omit<ServerCommonsApprovalState, "reviewId"> | null) =>
      act(() =>
        registry.set(
          state.approval!,
          AsyncResult.success(value === null ? null : { reviewId: "test-view", ...value }),
        ),
      ),
    [Symbol.dispose]: () => registry.dispose(),
  };
}

describe("Commons sharing review", () => {
  it("waits for the live subscription and cancels an early close before a submission id exists", async () => {
    using fixture = setup({ submissionId: "old", review: null });
    fixture.registry.set(state.approval!, AsyncResult.initial(false));
    const onReady = vi.fn();
    const onUnavailable = vi.fn();
    await using screen = await render(
      <RegistryContext value={fixture.registry}>
        <CommonsApprovalDialog
          reviewId="test-view"
          environmentId={environmentId}
          onReady={onReady}
          onUnavailable={onUnavailable}
        />
      </RegistryContext>,
    );
    expect(onReady).not.toHaveBeenCalled();
    await act(() =>
      fixture.registry.set(state.approval!, AsyncResult.waiting(AsyncResult.success(null))),
    );
    expect(onReady).toHaveBeenCalledTimes(1);
    await userEvent.click(page.getByRole("button", { name: "Cancel sharing" }));
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(state.respond).not.toHaveBeenCalled();
    await screen.unmount();
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });
  it("keeps the complete payload scrollable and requires a new decision for the next write", async () => {
    using fixture = setup({ submissionId: "submission", review: review("first") });
    await using screen = await render(fixture.ui());
    const request = page.getByRole("region", { name: "Complete sharing request" });
    const element = document.querySelector<HTMLElement>("[aria-label='Complete sharing request']")!;
    expect(element.textContent).toContain("first: LAST LINE MUST BE REVIEWABLE");
    expect(element.textContent).toContain("Effective SHA-256: effective-first");
    expect(element.scrollHeight).toBeGreaterThan(element.clientHeight);
    expect(element.clientHeight).toBeLessThanOrEqual(window.innerHeight / 2 + 1);
    element.scrollTop = element.scrollHeight;
    expect(element.scrollTop + element.clientHeight).toBeGreaterThanOrEqual(
      element.scrollHeight - 1,
    );
    await expect.element(request).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Approve once" }));
    expect(state.respond).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        submissionId: "submission",
        action: { type: "respond", requestId: "first", decision: "accept" },
      },
    });
    await fixture.set({ submissionId: "submission", review: null });
    await expect
      .element(page.getByRole("button", { name: "Approve once" }))
      .not.toBeInTheDocument();
    await fixture.set({ submissionId: "submission", review: review("second") });
    expect(state.respond).toHaveBeenCalledTimes(1);
    await userEvent.click(page.getByRole("button", { name: "Decline", exact: true }));
    expect(state.respond).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        submissionId: "submission",
        action: { type: "respond", requestId: "second", decision: "decline" },
      },
    });
    await screen.unmount();
    expect(state.respond).toHaveBeenLastCalledWith({
      environmentId,
      input: { submissionId: "submission", action: { type: "cancel" } },
    });
  });

  it("disables decisions after permission loss and keeps cancel available during preparation", async () => {
    using fixture = setup({ submissionId: "submission", review: review("current") });
    await using _screen = await render(fixture.ui());
    await act(() => fixture.registry.set(state.permission!, false));
    await expect.element(page.getByRole("button", { name: "Approve once" })).toBeDisabled();
    await act(() => fixture.registry.set(state.permission!, true));
    await fixture.set({ submissionId: "submission", review: null });
    await userEvent.click(page.getByRole("button", { name: "Cancel sharing" }));
    expect(state.respond).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { submissionId: "submission", action: { type: "cancel" } },
    });
  });

  it("shows a refused stale response without hiding the complete request", async () => {
    using fixture = setup({ submissionId: "submission", review: review("stale") });
    state.respond.mockRejectedValueOnce(new Error("The exact request expired."));
    await using _screen = await render(fixture.ui());
    await userEvent.click(page.getByRole("button", { name: "Approve once" }));
    await expect.element(page.getByRole("alert")).toHaveTextContent("The exact request expired.");
    expect(
      document.querySelector("[aria-label='Complete sharing request']")?.textContent,
    ).toContain("stale: LAST LINE MUST BE REVIEWABLE");
  });
});
