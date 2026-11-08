// Turns polled mouse and keyboard state into click and shortcut steps for the
// app being recorded. Typed text is never read: ordinary keys are only checked
// while Command or Control is held, outside protected fields, in that app.
import type { DesktopSkillRecordingStep } from "@t3tools/contracts";

/** The native reads the sampler needs for one app; see MacSkillInput.ts. */
export type SkillInputApi = {
  readonly frontPid: () => number | null;
  readonly flags: () => number;
  readonly buttonDown: (button: number) => boolean;
  readonly keyDown: (keyCode: number) => boolean;
  readonly pointer: () => { readonly x: number; readonly y: number } | null;
  /** The chosen app's focused element, or null when unknown. */
  readonly focus: () => {
    readonly role: string;
    readonly subrole: string | null;
    readonly protected: boolean;
  } | null;
  /** The chosen app's element under a point; null for other apps or protected fields. */
  readonly hitTest: (
    x: number,
    y: number,
  ) => {
    readonly role: string;
    readonly name: string | null;
    readonly elementKey: string | null;
  } | null;
  /** Releases this app's reader. */
  readonly close: () => void;
};

export type SkillInputStep = Omit<DesktopSkillRecordingStep, "atMs"> & {
  readonly kind: "click" | "shortcut";
};

// Physical ANSI key labels by macOS virtual key code. Labels can differ on
// other keyboard layouts; the reviewer sees and can correct them.
const KEY_NAMES: Readonly<Record<number, string>> = {
  0: "A",
  1: "S",
  2: "D",
  3: "F",
  4: "H",
  5: "G",
  6: "Z",
  7: "X",
  8: "C",
  9: "V",
  11: "B",
  12: "Q",
  13: "W",
  14: "E",
  15: "R",
  16: "Y",
  17: "T",
  18: "1",
  19: "2",
  20: "3",
  21: "4",
  22: "6",
  23: "5",
  24: "=",
  25: "9",
  26: "7",
  27: "-",
  28: "8",
  29: "0",
  30: "]",
  31: "O",
  32: "U",
  33: "[",
  34: "I",
  35: "P",
  36: "Return",
  37: "L",
  38: "J",
  39: "'",
  40: "K",
  41: ";",
  42: "\\",
  43: ",",
  44: "/",
  45: "N",
  46: "M",
  47: ".",
  48: "Tab",
  49: "Space",
  50: "`",
  51: "Delete",
  53: "Escape",
  96: "F5",
  97: "F6",
  98: "F7",
  99: "F3",
  100: "F8",
  101: "F9",
  103: "F11",
  109: "F10",
  111: "F12",
  115: "Home",
  116: "Page Up",
  117: "Forward Delete",
  118: "F4",
  119: "End",
  120: "F2",
  121: "Page Down",
  122: "F1",
  123: "Left Arrow",
  124: "Right Arrow",
  125: "Down Arrow",
  126: "Up Arrow",
};
const KEY_CODES = Object.keys(KEY_NAMES).map(Number);

// CGEventFlags, in the order macOS menus show them.
const MODIFIERS = [
  ["Control", 1 << 18],
  ["Option", 1 << 19],
  ["Shift", 1 << 17],
  ["Command", 1 << 20],
] as const;
const SHORTCUT_MASK = (1 << 18) | (1 << 20);
const BUTTONS = ["left", "right", "middle"] as const;
/** A reading older than this may describe a different moment than the press. */
const MAX_RESOLVE_MS = 50;

function heldModifiers(flags: number): Array<string> {
  return MODIFIERS.filter(([, mask]) => (flags & mask) !== 0).map(([name]) => name);
}

function clickPhrase(button: (typeof BUTTONS)[number], flags: number): string | null {
  const parts = [...heldModifiers(flags)];
  if (button !== "left") parts.push(button === "right" ? "Right" : "Middle");
  return parts.length ? `${parts.join("-")}-click` : null;
}

export type SkillInputCandidate = {
  readonly atMs: number;
  readonly step: SkillInputStep;
};

/**
 * Returns a function to call on every poll. Each call reports the clicks and
 * shortcuts that started since the last one. A press already held when the app
 * comes forward, or when a shortcut becomes possible, is never reported.
 */
export function makeSkillInputSampler(api: SkillInputApi, pid: number, now: () => number) {
  let buttons = BUTTONS.map((_, button) => api.buttonDown(button));
  let previousPid: number | null = null;
  let keys = new Set<number>();
  let armed = false;

  return (): Array<SkillInputCandidate> => {
    const atMs = now();
    const frontPid = api.frontPid();
    const down = BUTTONS.map((_, button) => api.buttonDown(button));
    const pressed = down.flatMap((isDown, button) => (isDown && !buttons[button] ? [button] : []));
    buttons = down;
    // An activation click lands while another app is still in front.
    const stayed = previousPid === pid && frontPid === pid;
    previousPid = frontPid;
    if (!stayed) {
      keys.clear();
      armed = false;
      return [];
    }

    const flags = api.flags();
    const output: Array<SkillInputCandidate> = [];
    for (const button of pressed) {
      const point = api.pointer();
      const target = point ? api.hitTest(point.x, point.y) : null;
      if (!target || api.frontPid() !== pid || now() - atMs > MAX_RESOLVE_MS) continue;
      output.push({
        atMs,
        step: {
          kind: "click",
          role: target.role,
          name: target.name,
          value: clickPhrase(BUTTONS[button] ?? "left", flags),
        },
      });
    }

    if ((flags & SHORTCUT_MASK) === 0) {
      keys.clear();
      armed = false;
      return output;
    }
    // Keys are only read while the focused element is known and not protected.
    const focused = api.focus();
    if (!focused || focused.protected) {
      keys.clear();
      armed = false;
      return output;
    }
    const downKeys = new Set(KEY_CODES.filter((keyCode) => api.keyDown(keyCode)));
    const stillSafe =
      api.flags() === flags &&
      api.frontPid() === pid &&
      now() - atMs <= MAX_RESOLVE_MS &&
      api.focus()?.protected === false;
    if (!stillSafe) {
      keys = downKeys;
      armed = false;
      return output;
    }
    if (armed) {
      for (const keyCode of downKeys) {
        if (keys.has(keyCode)) continue;
        output.push({
          atMs,
          step: {
            kind: "shortcut",
            role: focused.role,
            name: null,
            value: [...heldModifiers(flags), KEY_NAMES[keyCode]].join("+"),
          },
        });
      }
    }
    keys = downKeys;
    armed = true;
    return output;
  };
}
