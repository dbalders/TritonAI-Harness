// UCSD-themed pixel pets for the composer, ported from the Codex pet engine
// (openai/codex codex-rs/tui/src/pets): per-frame animation timing with loop
// segments, a small ambient wander state machine, and 16x16 sprite grids.

export const PET_GRID = 16;

export type PetId = "triton" | "trident" | "raccoon";

export const petCatalog: Record<PetId, { displayName: string; description: string }> = {
  triton: {
    displayName: "Triton",
    description: "The UC San Diego king, armed for deep work",
  },
  trident: {
    displayName: "Trident",
    description: "A pointed companion for fast iteration",
  },
  raccoon: {
    displayName: "Raccoon",
    description: "A campus bandit for curious workspace days",
  },
};

const petPalettes: Record<PetId, Record<string, string>> = {
  triton: {
    B: "#182A53",
    L: "#006A96",
    G: "#C69214",
    S: "#E8C39E",
    W: "#F2F7FC",
    K: "#101820",
    Z: "#7FD1F5",
    Y: "#FFD95E",
  },
  trident: {
    G: "#C69214",
    g: "#E8B94A",
    B: "#182A53",
    W: "#F2F7FC",
    K: "#101820",
    Z: "#7FD1F5",
    Y: "#FFD95E",
  },
  raccoon: {
    R: "#78818C",
    D: "#3C434E",
    K: "#1A1E24",
    W: "#F2F4F6",
    N: "#101418",
    Z: "#7FD1F5",
    Y: "#FFD95E",
  },
};

const tritonBase = [
  "....G.G.G.G.....",
  "...GGGGGGGGG....",
  "..BBBBBBBBBBB...",
  ".BBSSSSSSSBBBB..",
  ".BBSKSSSKSBBBB..",
  ".BBSSKKKSSSBBBB.",
  "..BWWWWWWWWWBGGG",
  "...WWWWWWWWWGGGG",
  "...BLLLLLLLBB.G.",
  "...BLLLLLLLBB.G.",
  "...BBLLLLLBBB.G.",
  "....BBBBBBB...G.",
  "....BB..BBB...G.",
  "....BB..BB....G.",
  "...GGG..GGG.....",
  "................",
];

const tritonVariants: Record<string, Record<number, string>> = {
  walk: {
    12: "....BBB.BBB...G.",
    13: "...BB.....BB..G.",
    14: "..GGG.....GGG...",
  },
  wave_up: {
    6: "G.BWWWWWWWWWBGGG",
    7: "G..WWWWWWWWWGGGG",
    8: "BB.BLLLLLLLBB.G.",
  },
  wave_out: { 8: ".BBBLLLLLLLBB.G." },
  jump: { 12: "....BBBBBB....G.", 13: "...GGGGG.....G..", 14: "" },
  sad: { 4: ".BBKSSSSSKBBBB..", 5: ".BBSSSKKKSSBBBB." },
  sleep: { 4: ".BBSKKSSSKKBBB..", 5: ".BBSSSSSSSSBBBB." },
  focus: { 5: ".BBSSSKKSSSBBBB." },
  zzz: { 0: "....G.G.G.G..ZZ.", 1: "...GGGGGGGGG.ZZ." },
  sparkle: { 0: "....G.G.G.G..Y.." },
};

const tridentBase = [
  "..G...G...G.....",
  "..G.g.G.g.G.....",
  "..GGGGGGGGGG....",
  "....GGGGG.......",
  "....GWWWG.......",
  "....GWKWG.......",
  "....GGGGG.......",
  "...BBBBBBB......",
  "....GGGGG.......",
  "....GGGGG.......",
  "....GGGGG.......",
  "....GGGGG.......",
  "....GG.GG.......",
  "....GG.GG.......",
  "...GGG.GGG......",
  "................",
];

const tridentVariants: Record<string, Record<number, string>> = {
  walk: {
    12: "....GGG.G.......",
    13: "...GG....GG.....",
    14: "..GGG....GGG....",
  },
  wave_up: { 6: "....GGGGG...G...", 7: "...BBBBBBB..G..." },
  wave_out: { 7: "...BBBBBBBBB...." },
  jump: { 12: "....GGGGG.......", 13: "...GGGGG........", 14: "" },
  sad: { 4: "....GGKKG.......", 5: "....GWKKWG......" },
  sleep: { 4: "....GKKKG.......", 5: "....GGGGG......." },
  focus: { 4: "....GWKWG.......", 5: "....GKKKG......." },
  zzz: { 0: "..G...G...G..ZZ.", 1: "..G.g.G.g.G..ZZ." },
  sparkle: { 0: "..G...G...G..Y.." },
};

const raccoonBase = [
  "..RR.......RR...",
  ".RRRRRRRRRRRRR..",
  ".RRRRRRRRRRRRR..",
  ".RKKKKRRRKKKKR..",
  ".RKWKKRRRKKWKR..",
  ".RRRRRRNRRRRRR..",
  "..RRRRRNRRRR....",
  "...RRRRRRRRR....",
  "...RRRRRRRRR.RR.",
  "...RRRRRRRRR.DD.",
  "...RRRRRRRRR.RR.",
  "....RRRRRRR.DD..",
  "....RR..RR......",
  "....RR..RR......",
  "...DDD..DDD.....",
  "................",
];

const raccoonVariants: Record<string, Record<number, string>> = {
  walk: {
    12: "....RRR.RRR.....",
    13: "...RR.....RR....",
    14: "..DDD.....DDD...",
  },
  wave_up: { 6: "..RRRRRNRRRR.RR.", 7: "...RRRRRRRRRRRR." },
  wave_out: { 8: "...RRRRRRRRRRR.." },
  jump: { 12: "....RRRRRR......", 13: "...DDDDD........", 14: "" },
  sad: { 4: ".RKKWKRRRKKWKR..", 6: "..RRRRNRRRRR...." },
  sleep: { 4: ".RKKKKRRRKKKKR.." },
  focus: { 4: ".RKWKKRRRKKWKR..", 5: ".RRRRRRNRRRRRR.." },
  zzz: { 0: "..RR.......RR.ZZ", 1: ".RRRRRRRRRRRRR.Z" },
  sparkle: { 0: "..RR.......RR.Y." },
};

const petBases: Record<PetId, string[]> = {
  triton: tritonBase,
  trident: tridentBase,
  raccoon: raccoonBase,
};

const petVariants: Record<PetId, Record<string, Record<number, string>>> = {
  triton: tritonVariants,
  trident: tridentVariants,
  raccoon: raccoonVariants,
};

function reverseString(value: string): string {
  let reversed = "";
  for (const character of value) {
    reversed = character + reversed;
  }
  return reversed;
}

export function composePetFrame(
  pet: PetId,
  patches: readonly string[] = [],
  shift = 0,
  flip = false,
): string[] {
  let rows = [...petBases[pet]];
  for (const patch of patches) {
    for (const [rowIndex, row] of Object.entries(petVariants[pet][patch] ?? {})) {
      rows[Number(rowIndex)] = row;
    }
  }
  rows = rows.filter((row) => row !== "");
  if (shift > 0) {
    rows = [...rows.slice(0, PET_GRID - shift), ...Array(shift).fill(".".repeat(PET_GRID))];
  } else if (shift < 0) {
    rows = [...Array(-shift).fill(".".repeat(PET_GRID)), ...rows].slice(0, PET_GRID);
  }
  const composed = flip ? rows.map(reverseString) : rows;
  return composed;
}

export function petPixelColors(pet: PetId, grid: string[]): Array<[string, number, number]> {
  const palette = petPalettes[pet];
  const pixels: Array<[string, number, number]> = [];
  for (const [y, row] of grid.entries()) {
    for (const [x, char] of [...row].entries()) {
      const color = palette[char];
      if (color) pixels.push([color, x, y]);
    }
  }
  return pixels;
}

export type PetAnimationFrame = {
  patches: readonly string[];
  shift: number;
  flip: boolean;
  duration: number;
};

export type PetAnimation = {
  frames: readonly PetAnimationFrame[];
  loop: boolean;
  fallback: string;
};

function frame(
  patches: readonly string[] = [],
  shift = 0,
  duration = 0.12,
  flip = false,
): PetAnimationFrame {
  return { patches, shift, flip, duration };
}

const runningFrames = [
  frame(["walk"], 0, 0.14),
  frame([], 0, 0.14),
  frame(["walk"], 0, 0.14),
  frame([], 1, 0.14),
];

const runningLeftFrames = runningFrames.map((item) => ({ ...item, flip: true }));

export const petAnimations: Record<string, PetAnimation> = {
  idle: {
    frames: [frame([], 0, 0.9), frame([], 1, 0.12)],
    loop: true,
    fallback: "idle",
  },
  running: { frames: runningFrames, loop: true, fallback: "idle" },
  running_right: { frames: runningFrames, loop: true, fallback: "idle" },
  running_left: { frames: runningLeftFrames, loop: true, fallback: "idle" },
  wave: {
    frames: [frame(["wave_up"], 0, 0.18), frame(["wave_out"], 0, 0.18)],
    loop: true,
    fallback: "idle",
  },
  jump: {
    frames: [frame(["jump"], -1, 0.35), frame([], 1, 0.15)],
    loop: false,
    fallback: "idle",
  },
  failed: {
    frames: [frame(["sad"], 0, 0.7), frame(["sad"], 1, 0.7)],
    loop: true,
    fallback: "idle",
  },
  waiting: {
    frames: [frame(["sleep", "zzz"], 0, 0.9), frame(["sleep"], 0, 0.9)],
    loop: true,
    fallback: "idle",
  },
  review: {
    frames: [frame(["focus", "sparkle"], 0, 0.6), frame(["focus"], 0, 0.6)],
    loop: true,
    fallback: "idle",
  },
};

export function petAnimationByName(name: string): PetAnimation {
  const named = petAnimations[name];
  if (named) return named;
  const idle = petAnimations.idle;
  if (idle) return idle;
  return { frames: [], loop: true, fallback: "idle" };
}

export function petFrameAt(animation: PetAnimation, elapsedSeconds: number) {
  const frames = animation.frames;
  const firstFrame = frames[0];
  const lastFrame = frames[frames.length - 1];
  if (!firstFrame) return null;
  if (!lastFrame) return null;
  const total = frames.reduce((sum, item) => sum + item.duration, 0);
  let elapsed = elapsedSeconds;
  if (animation.loop) {
    if (total > 0) elapsed %= total;
  } else if (elapsed >= total) {
    return { frame: lastFrame, delay: null };
  }
  let remaining = elapsed;
  for (const item of frames) {
    if (remaining < item.duration) {
      return { frame: item, delay: Math.max(item.duration - remaining, 0.01) };
    }
    remaining -= item.duration;
  }
  return { frame: lastFrame, delay: null };
}

export type PetAmbientState = {
  state: "idle" | "wander" | "wave" | "jump";
  until: number;
  targetX: number;
};

export const PET_WALK_SPEED = 52;

export function createPetAmbientState(now: number): PetAmbientState {
  return { state: "idle", until: now + 3, targetX: 0 };
}

function pickNextPetAmbientState(
  ambient: PetAmbientState,
  now: number,
  width: number,
  random: () => number,
): PetAmbientState {
  const roll = random();
  if (roll < 0.55) {
    return { ...ambient, state: "idle", until: now + 2.5 + random() * 3.5 };
  }
  if (roll < 0.85) {
    return {
      ...ambient,
      state: "wander",
      targetX: random() * Math.max(width - 1, 1),
      until: now + 30,
    };
  }
  if (roll < 0.94) {
    return { ...ambient, state: "wave", until: now + 1.6 };
  }
  return { ...ambient, state: "jump", until: now + 0.9 };
}

export function stepPetAmbient(
  ambient: PetAmbientState,
  now: number,
  elapsedSincePreviousTick: number,
  x: number,
  width: number,
  random: () => number = Math.random,
): { animation: string; x: number; ambient: PetAmbientState } {
  if (ambient.state === "wander") {
    const direction = ambient.targetX > x ? 1 : -1;
    const step = Math.max(PET_WALK_SPEED * elapsedSincePreviousTick, 0.5);
    let nextX = x + direction * step;
    if (
      (direction > 0 && nextX >= ambient.targetX) ||
      (direction < 0 && nextX <= ambient.targetX)
    ) {
      nextX = ambient.targetX;
      return {
        animation: "idle",
        x: nextX,
        ambient: { ...ambient, state: "idle", until: now + 2 + random() * 3 },
      };
    }
    return {
      animation: direction > 0 ? "running_right" : "running_left",
      x: nextX,
      ambient,
    };
  }
  if (now >= ambient.until) {
    return {
      animation: ambient.state,
      x,
      ambient: pickNextPetAmbientState(ambient, now, width, random),
    };
  }
  return { animation: ambient.state, x, ambient };
}
