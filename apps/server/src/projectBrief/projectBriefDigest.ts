// @effect-diagnostics nodeBuiltinImport:off -- This pure canonicalization helper needs a synchronous SHA-256 for immutable value identities.
import * as NodeCrypto from "node:crypto";

/** Stable request identities do not depend on the client's object-key order. */
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};
export const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
