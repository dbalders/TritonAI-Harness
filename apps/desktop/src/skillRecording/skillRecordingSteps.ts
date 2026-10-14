import type { DesktopSkillRecordingStep } from "@t3tools/contracts";

export const SKILL_RECORDING_MAX_DURATION_MS = 10 * 60_000;
export const SKILL_RECORDING_MAX_STEPS = 300;
const MAX_TEXT_CHARS = 160;
// Controls that can hold text the user typed, even when not reported editable,
// like a combo box's text field.
const TYPED_TEXT_ROLES = new Set(["combo_box", "search_field", "text_area", "text_field"]);
const RECORDED_STATE_FLAGS = new Set(["checked", "expanded", "selected"]);
// Value changes elsewhere are usually the app's own output, such as a
// progress bar or status label updating, not something the user did.
const USER_SET_VALUE_ROLES = new Set([
  "check_box",
  "color_well",
  "combo_box",
  "date_picker",
  "menu_button",
  "pop_up_button",
  "radio_button",
  "search_field",
  "slider",
  "spin_button",
  "stepper",
  "switch",
  "text_area",
  "text_field",
  "toggle_button",
]);

/** The parts of an xa11y event snapshot a recording reads. */
export type RecordedAccessibilityEvent = {
  readonly type: string;
  readonly stateFlag: string | null;
  readonly stateValue: boolean | null;
  readonly target: {
    readonly role: string;
    readonly name: string | null;
    readonly value: string | null;
    readonly editable: boolean;
    /** Whether the element had keyboard focus when the event fired, when known. */
    readonly focused?: boolean | null;
    readonly stableId: string | null;
    readonly raw: Record<string, unknown>;
  } | null;
};

type Target = NonNullable<RecordedAccessibilityEvent["target"]>;

function clip(text: string | null): string | null {
  const trimmed = text?.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_TEXT_CHARS ? `${trimmed.slice(0, MAX_TEXT_CHARS - 1)}…` : trimmed;
}

function normalized(text: string | null): string | null {
  return text?.replace(/\s+/g, " ").trim().toLowerCase() || null;
}

function isPasswordField(role: string, raw: Record<string, unknown>): boolean {
  if (/password|secure/i.test(role)) return true;
  const subrole = raw.ax_subrole;
  return typeof subrole === "string" && /secure/i.test(subrole);
}

function isProtected(target: Target): boolean {
  if (target.editable || TYPED_TEXT_ROLES.has(target.role)) return true;
  return isPasswordField(target.role, target.raw);
}

function read<A>(getter: () => A, fallback: A): A {
  try {
    return getter();
  } catch {
    return fallback;
  }
}

/** The getters of a native xa11y event that a recording reads. */
export type NativeAccessibilityEvent = {
  readonly type: string;
  readonly stateFlag: string | null;
  readonly stateValue: boolean | null;
  readonly target: {
    readonly role: string;
    readonly name: string | null;
    readonly value: string | null;
    readonly editable: boolean;
    readonly focused: boolean | null;
    readonly stableId: string | null;
    readonly raw: Record<string, unknown>;
  } | null;
};

/**
 * Copies a native event's getters once; each read crosses into the platform
 * API. A password field's label and contents are never read.
 */
export function snapshotAccessibilityEvent(
  event: NativeAccessibilityEvent,
): RecordedAccessibilityEvent {
  const target = read(() => event.target, null);
  if (!target) {
    return {
      type: read(() => event.type, ""),
      stateFlag: read(() => event.stateFlag, null),
      stateValue: read(() => event.stateValue, null),
      target: null,
    };
  }
  const role = read(() => target.role, "");
  const raw = read(() => target.raw, {});
  const password = isPasswordField(role, raw);
  return {
    type: read(() => event.type, ""),
    stateFlag: read(() => event.stateFlag, null),
    stateValue: read(() => event.stateValue, null),
    target: {
      role,
      name: password ? null : read(() => target.name, null),
      value: password ? null : read(() => target.value, null),
      editable: read(() => target.editable, true),
      focused: read(() => target.focused, null),
      stableId: read(() => target.stableId, null),
      raw: password ? { ax_subrole: raw.ax_subrole } : raw,
    },
  };
}

/** A value the user selected or toggled, never text they typed. */
function visibleValue(target: Target): string | null {
  return isProtected(target) ? null : clip(target.value);
}

type PendingStep = { readonly step: DesktopSkillRecordingStep; readonly elementKey: string };

function stepFromEvent(event: RecordedAccessibilityEvent, atMs: number): PendingStep | undefined {
  const target = event.target;
  if (!target) return undefined;
  // A text control can echo what was typed into its label; drop it then.
  // Compared in full, since clipping both could hide a long echo.
  const typed = normalized(target.value);
  const echoesTyping = isProtected(target) && !!typed && !!normalized(target.name)?.includes(typed);
  const base = { atMs, role: clip(target.role), name: echoesTyping ? null : clip(target.name) };
  // An echoed label changes with every keystroke, so it can't identify the field.
  const elementKey =
    target.stableId ?? `${target.role}\u0000${echoesTyping ? "" : (target.name ?? "")}`;
  switch (event.type) {
    case "focusChanged":
      return { elementKey, step: { ...base, kind: "focus", value: null } };
    case "valueChanged":
    case "textChanged":
      if (!target.editable && !USER_SET_VALUE_ROLES.has(target.role)) return undefined;
      // Apps update unfocused text controls to reflect state, like a font box
      // following the caret. Mouse-set controls, like sliders, often never
      // take focus, so their changes are kept either way.
      if (target.focused === false && TYPED_TEXT_ROLES.has(target.role)) return undefined;
      return { elementKey, step: { ...base, kind: "edit", value: visibleValue(target) } };
    case "selectionChanged":
      // In a text field this is the caret moving while the user types.
      if (target.editable) return undefined;
      return { elementKey, step: { ...base, kind: "select", value: visibleValue(target) } };
    case "stateChanged":
      if (!event.stateFlag || !RECORDED_STATE_FLAGS.has(event.stateFlag)) return undefined;
      return {
        elementKey,
        step: {
          ...base,
          kind: "toggle",
          value: `${event.stateFlag} ${event.stateValue ? "on" : "off"}`,
        },
      };
    case "windowOpened":
    case "windowActivated":
      return { elementKey, step: { ...base, kind: "window", value: null } };
    case "menuOpened":
      return { elementKey, step: { ...base, kind: "menu", value: null } };
    default:
      return undefined;
  }
}

function sameStep(left: DesktopSkillRecordingStep, right: DesktopSkillRecordingStep): boolean {
  return (
    left.kind === right.kind &&
    left.role === right.role &&
    left.name === right.name &&
    left.value === right.value
  );
}

/**
 * Collects a demonstration in memory under a step and time cap. Edits to the
 * same field collapse into one step, so typing a sentence is one step rather
 * than one per keystroke.
 */
export function makeSkillRecordingBuffer(
  limits: { readonly maxSteps: number; readonly maxDurationMs: number } = {
    maxSteps: SKILL_RECORDING_MAX_STEPS,
    maxDurationMs: SKILL_RECORDING_MAX_DURATION_MS,
  },
) {
  const steps: Array<DesktopSkillRecordingStep> = [];
  let lastElementKey: string | undefined;
  let focusedElementKey: string | undefined;

  // Reaching the cap ends the recording, so capture stops with the last step kept.
  const push = (step: DesktopSkillRecordingStep) => {
    steps.push(step);
    if (steps.length >= limits.maxSteps) limitReached = "steps";
  };
  const withinLimits = (atMs: number) => {
    if (limitReached) return false;
    if (atMs > limits.maxDurationMs) {
      limitReached = "time";
      return false;
    }
    return true;
  };
  let limitReached: "time" | "steps" | null = null;

  return {
    add(event: RecordedAccessibilityEvent, atMs: number) {
      if (!withinLimits(atMs)) return;
      const pending = stepFromEvent(event, Math.max(0, Math.round(atMs)));
      if (!pending) return;
      if (pending.step.kind === "focus") {
        // Apps re-announce focus on the same field as windows come and go.
        if (focusedElementKey === pending.elementKey) return;
        focusedElementKey = pending.elementKey;
      }
      const previous = steps.at(-1);
      if (previous && sameStep(previous, pending.step) && lastElementKey === pending.elementKey) {
        return;
      }
      if (previous?.kind === "edit" && pending.step.kind === "edit") {
        if (lastElementKey === pending.elementKey) {
          steps[steps.length - 1] = { ...pending.step, atMs: previous.atMs };
          return;
        }
      }
      push(pending.step);
      lastElementKey = pending.elementKey;
    },
    /** Marks the user moving to another app; what follows happened there. */
    addApp(name: string, atMs: number) {
      if (!withinLimits(atMs)) return;
      push({
        atMs: Math.max(0, Math.round(atMs)),
        kind: "app",
        role: null,
        name: clip(name),
        value: null,
      });
      lastElementKey = undefined;
      focusedElementKey = undefined;
    },
    /** Adds a click or shortcut. Repeats are kept: pressing twice is two actions. */
    addInput(step: Omit<DesktopSkillRecordingStep, "atMs">, atMs: number) {
      if (!withinLimits(atMs)) return;
      const input = { ...step, atMs: Math.max(0, Math.round(atMs)) };
      push(input);
      lastElementKey = undefined;
    },
    /** True once the step cap is hit; capture should stop then. */
    isFull: () => limitReached === "steps",
    markTimeLimit() {
      limitReached ??= "time";
    },
    finish() {
      return { steps: [...steps], limitReached };
    },
  };
}
