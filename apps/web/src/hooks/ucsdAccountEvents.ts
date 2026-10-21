import type { EnvironmentId } from "@t3tools/contracts";

const ACCOUNT_CHANGED_EVENT = "tritonai-account-changed";
type AccountChange = { readonly environmentId: EnvironmentId };

export function emitUcsdAccountChanged(environmentId: EnvironmentId): void {
  window.dispatchEvent(
    new CustomEvent<AccountChange>(ACCOUNT_CHANGED_EVENT, { detail: { environmentId } }),
  );
}

export function onUcsdAccountChanged(
  environmentId: EnvironmentId | null,
  listener: () => void,
): () => void {
  const handler = (event: Event) => {
    if ((event as CustomEvent<AccountChange>).detail?.environmentId === environmentId) listener();
  };
  window.addEventListener(ACCOUNT_CHANGED_EVENT, handler);
  return () => window.removeEventListener(ACCOUNT_CHANGED_EVENT, handler);
}
