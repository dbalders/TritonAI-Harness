// Settings shared by the sidebar picker and the desktop pet.

import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PawPrintIcon } from "lucide-react";

import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  PET_GRID,
  composePetFrame,
  petCatalog,
  petPixelColors,
  type PetId,
} from "./petCompanionSprites";

export type PetCompanionSelection = PetId | "off";

type PetSelectionListener = () => void;

const PET_STORAGE_KEY = "t3.pet-companion";
const petSelectionListeners: Set<PetSelectionListener> = new Set();
const petSelectionValues = new Set(["off", "triton", "trident", "raccoon"]);

function isPetSelection(value: string): value is PetCompanionSelection {
  return petSelectionValues.has(value);
}

function readStoredPetSelection(): PetCompanionSelection {
  try {
    const stored = window.localStorage.getItem(PET_STORAGE_KEY);
    if (stored !== null && isPetSelection(stored)) return stored;
  } catch {
    // Storage is unavailable; the in-memory default still works.
  }
  return "triton";
}

let petSelectionInitialized = false;
let petSelectionValue: PetCompanionSelection = "triton";

function currentPetSelection(): PetCompanionSelection {
  if (!petSelectionInitialized) {
    petSelectionValue = readStoredPetSelection();
    petSelectionInitialized = true;
  }
  return petSelectionValue;
}

export function setPetCompanionSelection(selection: PetCompanionSelection) {
  petSelectionValue = selection;
  petSelectionInitialized = true;
  try {
    window.localStorage.setItem(PET_STORAGE_KEY, selection);
  } catch {
    // Ignore storage failures; the session choice still applies.
  }
  for (const listener of petSelectionListeners) {
    listener();
  }
}

function subscribePetSelection(listener: PetSelectionListener) {
  petSelectionListeners.add(listener);
  return () => {
    petSelectionListeners.delete(listener);
  };
}

export function usePetCompanionSelection(): PetCompanionSelection {
  return useSyncExternalStore(subscribePetSelection, currentPetSelection);
}

export type PetCompanionMovement = "static" | "playful";

const PET_MOVEMENT_STORAGE_KEY = "t3.pet-companion-movement";
const petMovementValues = new Set(["static", "playful"]);
type PetMovementListener = () => void;
const petMovementListeners: Set<PetMovementListener> = new Set();

function isPetMovement(value: string): value is PetCompanionMovement {
  return petMovementValues.has(value);
}

let petMovementInitialized = false;
let petMovementValue: PetCompanionMovement = "static";

function currentPetMovement(): PetCompanionMovement {
  if (!petMovementInitialized) {
    try {
      const stored = window.localStorage.getItem(PET_MOVEMENT_STORAGE_KEY);
      if (stored !== null && isPetMovement(stored)) petMovementValue = stored;
    } catch {
      // Storage is unavailable; the safe static default still applies.
    }
    petMovementInitialized = true;
  }
  return petMovementValue;
}

export function setPetCompanionMovement(movement: PetCompanionMovement) {
  petMovementValue = movement;
  petMovementInitialized = true;
  try {
    window.localStorage.setItem(PET_MOVEMENT_STORAGE_KEY, movement);
  } catch {
    // Ignore storage failures; the session choice still applies.
  }
  for (const listener of petMovementListeners) listener();
}

function subscribePetMovement(listener: PetMovementListener) {
  petMovementListeners.add(listener);
  return () => {
    petMovementListeners.delete(listener);
  };
}

export function usePetCompanionMovement(): PetCompanionMovement {
  return useSyncExternalStore(subscribePetMovement, currentPetMovement);
}

// The writing window does not receive its own storage events, so setters still
// notify locally; this keeps every other open window from saving stale choices.
window.addEventListener("storage", (event) => {
  if (event.key === PET_STORAGE_KEY && event.newValue !== null && isPetSelection(event.newValue)) {
    petSelectionValue = event.newValue;
    petSelectionInitialized = true;
    for (const listener of petSelectionListeners) listener();
    return;
  }
  if (
    event.key === PET_MOVEMENT_STORAGE_KEY &&
    event.newValue !== null &&
    isPetMovement(event.newValue)
  ) {
    petMovementValue = event.newValue;
    petMovementInitialized = true;
    for (const listener of petMovementListeners) listener();
  }
});

const petPreviewClass = "size-7 shrink-0 rounded-(--control-radius) [image-rendering:pixelated]";

const PetPreviewCanvas = memo(function PetPreviewCanvas(props: { pet: PetId }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // oxlint-disable-next-line t3code/react-effect-budget -- canvas pixels are imperative and cannot be represented declaratively
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, PET_GRID, PET_GRID);
    for (const [color, x, y] of petPixelColors(props.pet, composePetFrame(props.pet))) {
      context.fillStyle = color;
      context.fillRect(x, y, 1, 1);
    }
  }, [props.pet]);

  return (
    <canvas
      ref={canvasRef}
      width={PET_GRID}
      height={PET_GRID}
      aria-hidden="true"
      className={petPreviewClass}
    />
  );
});

const petPickerOptions: Array<PetCompanionSelection> = ["triton", "trident", "raccoon", "off"];

function petPickerLabel(option: PetCompanionSelection) {
  return option === "off" ? "Off" : petCatalog[option].displayName;
}

function petPickerDescription(option: PetCompanionSelection) {
  return option === "off" ? "Hide desktop pet" : petCatalog[option].description;
}

export const PetCompanionSidebarItem = memo(function PetCompanionSidebarItem() {
  const [open, setOpen] = useState(false);
  const selection = usePetCompanionSelection();
  const movement = usePetCompanionMovement();
  if (!window.desktopBridge?.pet) return null;

  return (
    <SidebarMenuItem className="relative shrink-0">
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger render={<SidebarMenuButton aria-label="Pet companion" size="icon" />}>
                <PawPrintIcon />
              </PopoverTrigger>
            }
          />
          <TooltipPopup side="top">Pet companion</TooltipPopup>
        </Tooltip>
        <PopoverPopup aria-label="Pet companion" padding="compact" side="top" width="sm">
          <div className="grid gap-1">
            {petPickerOptions.map((option) => (
              <PopoverClose
                key={option}
                render={
                  <button
                    type="button"
                    aria-pressed={selection === option}
                    onClick={() => setPetCompanionSelection(option)}
                    className="flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left outline-hidden ring-ring hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset data-pressed:bg-muted"
                  />
                }
              >
                {option === "off" ? (
                  <div className="grid size-7 shrink-0 place-items-center rounded-(--control-radius) bg-muted">
                    <PawPrintIcon className="size-3.5 text-muted-foreground" />
                  </div>
                ) : (
                  <PetPreviewCanvas pet={option} />
                )}
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="truncate font-medium text-foreground">
                    {petPickerLabel(option)}
                  </span>
                  <span className="truncate text-xs leading-4 text-muted-foreground">
                    {petPickerDescription(option)}
                  </span>
                </span>
              </PopoverClose>
            ))}
            <button
              type="button"
              aria-pressed={movement === "static"}
              onClick={() => setPetCompanionMovement(movement === "static" ? "playful" : "static")}
              className="rounded-md px-2 py-1.5 text-left hover:bg-muted"
            >
              Movement: {movement === "static" ? "Static" : "Playful"}
            </button>
          </div>
        </PopoverPopup>
      </Popover>
    </SidebarMenuItem>
  );
});
