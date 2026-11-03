import type { DesktopPetAction } from "@t3tools/contracts";

/** Actions the pet window itself may send to the owning chat renderer. */
export type PetWindowAction = Extract<
  DesktopPetAction,
  { kind: "close" | "set-pet" | "set-movement" | "select-thread" }
>;

const pets = new Set(["triton", "trident", "raccoon", "off"]);
const movements = new Set(["static", "playful"]);

export function isPetWindowAction(value: unknown): value is PetWindowAction {
  if (typeof value !== "object" || value === null) return false;
  const action = value as {
    kind?: unknown;
    pet?: unknown;
    movement?: unknown;
    environmentId?: unknown;
    threadId?: unknown;
  };
  if (action.kind === "close") return true;
  if (action.kind === "set-movement") return movements.has(action.movement as string);
  if (action.kind === "set-pet") return pets.has(action.pet as string);
  if (action.kind === "select-thread") {
    return typeof action.environmentId === "string" && typeof action.threadId === "string";
  }
  return false;
}
