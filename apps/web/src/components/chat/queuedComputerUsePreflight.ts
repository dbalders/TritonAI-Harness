import { describeComputerUseReadiness, type ProviderDriverKind } from "@t3tools/contracts";
import {
  isBareComputerUseRequest,
  isComputerUseRequest,
  readComputerUseStateWithTimeout,
} from "../../computerUse";

export async function assertQueuedComputerUseReady(input: {
  readonly prompt: string;
  readonly provider: ProviderDriverKind;
  readonly localDesktop: boolean;
  readonly usesWsl: boolean;
  readonly readState: () => Promise<Parameters<typeof describeComputerUseReadiness>[0]>;
}): Promise<void> {
  if (!isComputerUseRequest(input.prompt)) return;
  if (input.provider !== "codex") throw new Error("Choose the Codex provider to use desktop apps.");
  // The desktop bridge can only attest to this computer. Remote and web clients
  // use their target backend's computer-use instructions, as the composer does.
  if (!input.localDesktop) return;
  if (input.usesWsl)
    throw new Error("Choose this computer's native desktop environment to use desktop apps.");
  const readiness = describeComputerUseReadiness(
    await readComputerUseStateWithTimeout(input.readState),
  );
  if (!readiness.ready) throw new Error(`Computer use · ${readiness.label}: ${readiness.detail}`);
  if (isBareComputerUseRequest(input.prompt))
    throw new Error("Add what you want to do after /computer-use.");
}
