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

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

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
