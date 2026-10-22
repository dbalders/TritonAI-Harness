import { useRef, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import type { DotCapability } from "./dotDiscovery";
import type { DotPromptSchedule, DotScheduledPrompt } from "./dotRoutines";

export interface DotRoutineInput {
  readonly name: string;
  readonly prompt: string;
  readonly schedule: DotPromptSchedule;
  readonly timezone: string;
  readonly notify: "always" | "if-notable";
}

const RECIPES = [
  {
    id: "custom",
    name: "Custom routine",
    capability: "",
    input: "What should the bot check?",
    prompt: "",
    output: "A concise update with sources, completed checks, and anything needing my decision.",
  },
  {
    id: "inbox",
    name: "Inbox follow-up",
    capability: "attention",
    input: "People, projects, or deadlines to focus on",
    prompt: "Review my inbox for items needing a reply or follow-up.",
    output:
      "A short prioritized list with source links and a suggested next step. Draft replies for review; do not send them.",
  },
  {
    id: "calendar",
    name: "Meeting preparation",
    capability: "calendar",
    input: "Meetings or projects to focus on",
    prompt: "Prepare me for upcoming meetings.",
    output:
      "An agenda, relevant context with sources, open questions, and any missing information.",
  },
  {
    id: "github",
    name: "Project check-in",
    capability: "github",
    input: "Repository or project",
    prompt: "Check progress and blockers for the selected project.",
    output:
      "Changes since the last check, supporting links, checks completed, and decisions needed.",
  },
] as const;

function connectionNote(
  recipe: (typeof RECIPES)[number],
  capabilities: readonly DotCapability[] | undefined,
) {
  if (!recipe.capability) return null;
  const capability = capabilities?.find((item) => item.id.includes(recipe.capability));
  if (!capability)
    return "Connection availability is not reported. Confirm the bot can access these sources before saving.";
  return capability.availability.status === "available"
    ? null
    : capability.availability.status === "needs-connection"
      ? capability.availability.how
      : capability.availability.why;
}

export function BotRoutineEditor({
  prompt,
  capabilities,
  onSave,
  onPreview,
  onCancel,
}: {
  readonly prompt?: DotScheduledPrompt | undefined;
  readonly capabilities: readonly DotCapability[] | undefined;
  readonly onSave: (input: DotRoutineInput, prompt?: DotScheduledPrompt) => Promise<unknown>;
  readonly onPreview: (
    input: Pick<DotRoutineInput, "schedule" | "timezone">,
  ) => Promise<{ scheduleText: string; nextRunAt?: string }>;
  readonly onCancel: () => void;
}) {
  const [recipeId, setRecipeId] = useState("custom");
  const recipe = RECIPES.find((item) => item.id === recipeId) ?? RECIPES[0];
  const [name, setName] = useState(prompt?.name ?? "");
  const [instructions, setInstructions] = useState(prompt?.prompt ?? "");
  const [inputs, setInputs] = useState("");
  const [output, setOutput] = useState(prompt ? "" : (RECIPES[0].output as string));
  const [kind, setKind] = useState<DotPromptSchedule["kind"]>(prompt?.schedule.kind ?? "weekdays");
  const [time, setTime] = useState(prompt?.schedule.time ?? "09:00");
  const [minutes, setMinutes] = useState(String(prompt?.schedule.everyMinutes ?? 60));
  const [days, setDays] = useState<NonNullable<DotPromptSchedule["days"]>>(
    prompt?.schedule.days ?? [],
  );
  const [windowFrom, setWindowFrom] = useState(prompt?.schedule.window?.from ?? "");
  const [windowTo, setWindowTo] = useState(prompt?.schedule.window?.to ?? "");
  const [timezone, setTimezone] = useState(
    prompt?.timezone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [notify, setNotify] = useState<DotRoutineInput["notify"]>(prompt?.notify ?? "if-notable");
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const schedule: DotPromptSchedule =
    kind === "interval"
      ? {
          kind,
          everyMinutes: Number(minutes),
          ...(windowFrom && windowTo ? { window: { from: windowFrom, to: windowTo } } : {}),
          ...(days.length ? { days } : {}),
        }
      : { kind, time, ...(kind === "weekly" ? { days } : {}) };
  const composed = [
    instructions.trim(),
    inputs.trim() ? `Focus: ${inputs.trim()}` : "",
    output.trim() ? `Expected output: ${output.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const note = connectionNote(recipe, capabilities);

  async function submit(previewOnly: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      if (previewOnly) {
        const result = await onPreview({ schedule, timezone });
        setPreview(
          `${result.scheduleText} · ${timezone}${result.nextRunAt ? ` · Next: ${new Date(result.nextRunAt).toLocaleString()}` : ""}`,
        );
      } else {
        await onSave({ name: name.trim(), prompt: composed, schedule, timezone, notify }, prompt);
        onCancel();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this routine.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <form
      aria-label={prompt ? "Edit routine" : "Create routine"}
      className="space-y-3 rounded-lg border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(false);
      }}
    >
      <h3 className="font-semibold">{prompt ? `Edit ${prompt.name}` : "Create a routine"}</h3>
      {!prompt && (
        <label className="block space-y-1">
          Start from a recipe
          <select
            aria-label="Recipe"
            className="w-full rounded border bg-background p-2"
            value={recipeId}
            disabled={busy}
            onChange={(event) => {
              const selected = RECIPES.find((item) => item.id === event.target.value) ?? RECIPES[0];
              setRecipeId(selected.id);
              setName(selected.id === "custom" ? "" : selected.name);
              setInstructions(selected.prompt);
              setInputs("");
              setOutput(selected.output);
            }}
          >
            {RECIPES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {note && (
        <p role="status" className="text-xs text-muted-foreground">
          {note}
        </p>
      )}
      <label className="block space-y-1">
        Name
        <Input
          nativeInput
          aria-label="Routine name"
          required
          maxLength={100}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      {recipe.id !== "custom" && (
        <label className="block space-y-1">
          {recipe.input}
          <Input
            nativeInput
            aria-label="Recipe inputs"
            required
            value={inputs}
            disabled={busy}
            onChange={(event) => setInputs(event.currentTarget.value)}
          />
        </label>
      )}
      <label className="block space-y-1">
        Instructions
        <Textarea
          aria-label="Routine instructions"
          required
          value={instructions}
          disabled={busy}
          onChange={(event) => setInstructions(event.currentTarget.value)}
        />
      </label>
      <label className="block space-y-1">
        Expected output
        <Textarea
          aria-label="Expected output"
          value={output}
          disabled={busy}
          onChange={(event) => setOutput(event.currentTarget.value)}
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1">
          Repeat
          <select
            aria-label="Routine cadence"
            className="w-full rounded border bg-background p-2"
            value={kind}
            disabled={busy}
            onChange={(event) => {
              setKind(event.target.value as DotPromptSchedule["kind"]);
              setPreview(null);
            }}
          >
            <option value="daily">Daily</option>
            <option value="weekdays">Weekdays</option>
            <option value="weekly">Weekly</option>
            <option value="interval">Every few minutes</option>
          </select>
        </label>
        {kind === "interval" ? (
          <label className="block space-y-1">
            Minutes
            <Input
              nativeInput
              type="number"
              min={30}
              max={1440}
              step={5}
              required
              aria-label="Routine interval minutes"
              value={minutes}
              disabled={busy}
              onChange={(event) => {
                setMinutes(event.currentTarget.value);
                setPreview(null);
              }}
            />
          </label>
        ) : (
          <label className="block space-y-1">
            Time
            <Input
              nativeInput
              type="time"
              required
              aria-label="Routine time"
              value={time}
              disabled={busy}
              onChange={(event) => {
                setTime(event.currentTarget.value);
                setPreview(null);
              }}
            />
          </label>
        )}
      </div>
      {(kind === "weekly" || kind === "interval") && (
        <fieldset>
          <legend>{kind === "interval" ? "Days (leave empty for every day)" : "Days"}</legend>
          <div className="flex flex-wrap gap-2">
            {(["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((day) => (
              <label key={day}>
                <input
                  type="checkbox"
                  checked={days.includes(day)}
                  disabled={busy}
                  onChange={(event) => {
                    setDays(
                      event.target.checked ? [...days, day] : days.filter((value) => value !== day),
                    );
                    setPreview(null);
                  }}
                />{" "}
                {day}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {kind === "interval" && (
        <fieldset className="space-y-2">
          <legend>Time window (optional)</legend>
          <div className="grid grid-cols-2 gap-2">
            <label>
              From
              <Input
                nativeInput
                type="time"
                aria-label="Routine window start"
                value={windowFrom}
                required={Boolean(windowTo)}
                disabled={busy}
                onChange={(event) => {
                  setWindowFrom(event.currentTarget.value);
                  setPreview(null);
                }}
              />
            </label>
            <label>
              To
              <Input
                nativeInput
                type="time"
                aria-label="Routine window end"
                value={windowTo}
                required={Boolean(windowFrom)}
                disabled={busy}
                onChange={(event) => {
                  setWindowTo(event.currentTarget.value);
                  setPreview(null);
                }}
              />
            </label>
          </div>
        </fieldset>
      )}
      <label className="block space-y-1">
        Timezone
        <Input
          nativeInput
          required
          aria-label="Routine timezone"
          value={timezone}
          disabled={busy}
          onChange={(event) => {
            setTimezone(event.currentTarget.value);
            setPreview(null);
          }}
        />
      </label>
      <label className="block space-y-1">
        Notify me
        <select
          aria-label="Routine notifications"
          className="w-full rounded border bg-background p-2"
          value={notify}
          disabled={busy}
          onChange={(event) => setNotify(event.target.value as DotRoutineInput["notify"])}
        >
          <option value="if-notable">Only when something needs attention</option>
          <option value="always">After every run</option>
        </select>
      </label>
      <details>
        <summary className="cursor-pointer font-medium">Preview instructions and output</summary>
        <p className="mt-2 whitespace-pre-wrap break-words">
          {composed || "Add instructions above."}
        </p>
      </details>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void submit(true)}
      >
        Preview schedule
      </Button>
      {preview && (
        <p role="status" className="text-xs text-muted-foreground">
          {preview}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={
            busy || !name.trim() || !instructions.trim() || (kind === "weekly" && !days.length)
          }
        >
          {busy ? "Saving…" : "Save routine"}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
