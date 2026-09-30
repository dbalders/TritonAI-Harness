// @effect-diagnostics globalDate:off - memory days are host-local calendar days.
/**
 * Local calendar days for the daily memory summary.
 *
 * A "day" is the user's local day, `YYYY-MM-DD`, because that is how people
 * remember their work. Messages are stored as UTC ISO timestamps, so each day
 * maps to a UTC range that starts and ends at local midnight.
 */

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocalDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The host-local day containing an epoch-millisecond instant. */
export function localDayAt(epochMillis: number): string {
  return formatLocalDay(new Date(epochMillis));
}

function localMidnight(day: string, offsetDays = 0): Date {
  const match = DAY_PATTERN.exec(day);
  if (!match) throw new Error(`Not a local day: ${day}`);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + offsetDays);
}

export function isLocalDay(value: string): boolean {
  const match = DAY_PATTERN.exec(value);
  return match !== null && formatLocalDay(localMidnight(value)) === value;
}

export function addLocalDays(day: string, days: number): string {
  return formatLocalDay(localMidnight(day, days));
}

/** The UTC ISO range `[start, end)` covering one local day, DST included. */
export function localDayRange(day: string): { readonly startIso: string; readonly endIso: string } {
  return {
    startIso: localMidnight(day).toISOString(),
    endIso: localMidnight(day, 1).toISOString(),
  };
}

/**
 * Finished days that still need a note, oldest first.
 *
 * Today is never included because it is still happening. The window is capped
 * so the first run, or a return after memory was off for months, summarizes
 * recent work instead of the whole history.
 */
export function pendingMemoryDays(input: {
  readonly lastSummarizedDay: string | null;
  readonly today: string;
  readonly maxCatchUpDays: number;
}): ReadonlyArray<string> {
  const earliest = addLocalDays(input.today, -input.maxCatchUpDays);
  const afterLast =
    input.lastSummarizedDay === null ? earliest : addLocalDays(input.lastSummarizedDay, 1);
  const days: string[] = [];
  for (
    let day = afterLast > earliest ? afterLast : earliest;
    day < input.today;
    day = addLocalDays(day, 1)
  ) {
    days.push(day);
  }
  return days;
}
