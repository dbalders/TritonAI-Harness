import { expect, it } from "vite-plus/test";

import { act, render } from "../../../test/render";
import {
  setPetCompanionMovement,
  setPetCompanionSelection,
  usePetCompanionMovement,
  usePetCompanionSelection,
} from "./PetCompanion";

function Probe() {
  const selection = usePetCompanionSelection();
  const movement = usePetCompanionMovement();
  return <div>{`${selection}/${movement}`}</div>;
}

it("syncs pet preferences written by another window", async () => {
  setPetCompanionSelection("triton");
  setPetCompanionMovement("static");
  await using screen = await render(<Probe />);
  expect(screen.container.textContent).toBe("triton/static");

  await act(async () => {
    window.localStorage.setItem("t3.pet-companion", "trident");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "t3.pet-companion", newValue: "trident" }),
    );
  });
  expect(screen.container.textContent).toBe("trident/static");

  await act(async () => {
    window.localStorage.setItem("t3.pet-companion-movement", "playful");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "t3.pet-companion-movement",
        newValue: "playful",
      }),
    );
  });
  expect(screen.container.textContent).toBe("trident/playful");
});
