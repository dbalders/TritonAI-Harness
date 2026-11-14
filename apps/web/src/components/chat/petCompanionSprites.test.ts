import { describe, expect, it } from "vite-plus/test";

import {
  PET_GRID,
  composePetFrame,
  createPetAmbientState,
  petAnimationByName,
  petAnimations,
  petCatalog,
  petFrameAt,
  stepPetAmbient,
  type PetAmbientState,
} from "./petCompanionSprites";

const pets = Object.keys(petCatalog) as Array<keyof typeof petCatalog>;

describe("composePetFrame", () => {
  it.each(pets)("builds a full %s grid", (pet) => {
    const grid = composePetFrame(pet);
    expect(grid).toHaveLength(PET_GRID);
    for (const row of grid) {
      expect(row).toHaveLength(PET_GRID);
    }
  });

  it.each(pets)("applies every animation patch for %s", (pet) => {
    for (const animation of Object.values(petAnimations)) {
      for (const frame of animation.frames) {
        const grid = composePetFrame(pet, frame.patches, frame.shift, frame.flip);
        expect(grid).toHaveLength(PET_GRID);
        for (const row of grid) {
          expect(row).toHaveLength(PET_GRID);
        }
      }
    }
  });

  it("flips the sprite horizontally", () => {
    const grid = composePetFrame("triton");
    const flipped = composePetFrame("triton", [], 0, true);
    const firstRow = grid[0] ?? "";
    expect(flipped[0]).toBe(Array.from(firstRow).toReversed().join(""));
  });
});

describe("petFrameAt", () => {
  it("uses per-frame durations", () => {
    const result = petFrameAt(petAnimationByName("idle"), 0.95);
    expect(result?.frame.shift).toBe(1);
    expect(result?.delay).toBeCloseTo(0.07, 2);
  });

  it("wraps looping animations", () => {
    const result = petFrameAt(petAnimationByName("running"), 100);
    expect(result).not.toBeNull();
    expect(result?.frame.duration).toBe(0.14);
  });

  it("holds the final frame of non-looping animations", () => {
    const result = petFrameAt(petAnimationByName("jump"), 10);
    expect(result?.frame.shift).toBe(1);
    expect(result?.delay).toBeNull();
  });
});

describe("stepPetAmbient", () => {
  it("walks toward the wander target", () => {
    const now = 10;
    const ambient: PetAmbientState = {
      ...createPetAmbientState(now),
      state: "wander",
      targetX: 400,
    };
    const stepped = stepPetAmbient(ambient, now + 0.1, 0.1, 0, 1000, () => 0.5);
    expect(stepped.animation).toBe("running_right");
    expect(stepped.x).toBeGreaterThan(0);
    expect(stepped.ambient.state).toBe("wander");
  });

  it("settles into idle after a short action", () => {
    const now = 10;
    const ambient: PetAmbientState = {
      ...createPetAmbientState(now),
      state: "wave",
      until: now + 1.6,
    };
    const during = stepPetAmbient(ambient, now + 1, 0.1, 0, 1000, () => 0.5);
    expect(during.animation).toBe("wave");
    const after = stepPetAmbient(ambient, now + 2, 0.1, 0, 1000, () => 0.5);
    expect(after.ambient.until).toBeGreaterThan(now + 2);
  });
});
