import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { installIntegrationWriteGate } from "./IntegrationWriteApproval.ts";

export const integrationWriteTestOwner = {
  threadId: ThreadId.make("integration-write-fixture-thread"),
  providerSessionId: "integration-write-fixture-session",
  providerInstanceId: ProviderInstanceId.make("integration-write-fixture-instance"),
};

export function installApprovedIntegrationWriteFixture() {
  return installIntegrationWriteGate(integrationWriteTestOwner.providerInstanceId, (review) =>
    Effect.succeed(
      review.owner.providerSessionId === integrationWriteTestOwner.providerSessionId
        ? { approved: true as const, isCurrent: () => true }
        : { approved: false as const },
    ),
  );
}
