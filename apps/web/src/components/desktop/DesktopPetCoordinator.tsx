import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useThreadShells } from "../../state/entities";
import {
  setPetCompanionMovement,
  setPetCompanionSelection,
  usePetCompanionMovement,
  usePetCompanionSelection,
} from "../chat/PetCompanion";
import { computePetSummaries } from "./desktopPetThreads";

export function DesktopPetCoordinator() {
  const pet = window.desktopBridge?.pet;
  const navigate = useNavigate();
  const selection = usePetCompanionSelection();
  const movement = usePetCompanionMovement();
  const threads = useThreadShells();
  const openedRef = useRef(false);
  const queueRef = useRef(Promise.resolve());
  const seenRef = useRef(new Set<string>());
  const selectionRef = useRef(selection);

  // oxlint-disable-next-line t3code/react-effect-budget -- keep latest selection available to the IPC callback without resubscribing
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  // oxlint-disable-next-line t3code/react-effect-budget -- serialize renderer state changes into the desktop pet
  useEffect(() => {
    if (!pet) return;
    if (selection === "off") seenRef.current.clear();
    const summaries = selection === "off" ? [] : computePetSummaries(threads, seenRef.current);
    let cancelled = false;
    queueRef.current = queueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (cancelled) return;
        if (selection === "off") {
          openedRef.current = false;
          await pet.close();
          return;
        }
        if (!openedRef.current) {
          await pet.open();
          openedRef.current = true;
        }
        if (!cancelled) {
          await pet.setState({
            pet: selection,
            movement,
            threads: summaries,
          });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [movement, pet, selection, threads]);

  // oxlint-disable-next-line t3code/react-effect-budget -- subscribe to pet IPC actions for the component lifetime
  useEffect(() => {
    if (!pet) return;
    return pet.onAction((action) => {
      if (action.kind === "set-pet") {
        setPetCompanionSelection(action.pet);
        return;
      }
      if (action.kind === "set-movement") {
        setPetCompanionMovement(action.movement);
        return;
      }
      if (action.kind === "close") {
        if (selectionRef.current !== "off") setPetCompanionSelection("off");
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: action.environmentId, threadId: action.threadId },
      }).catch(() => undefined);
    });
  }, [navigate, pet]);

  // oxlint-disable-next-line t3code/react-effect-budget -- close the desktop pet once when the bridge goes away
  useEffect(() => {
    if (!pet) return;
    return () => {
      queueRef.current = queueRef.current
        .catch(() => undefined)
        .then(async () => {
          openedRef.current = false;
          await pet.close();
        })
        .catch(() => undefined);
    };
  }, [pet]);

  return null;
}
