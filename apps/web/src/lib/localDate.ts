/**
 * Local-date helpers (YYYY-MM-DD).
 *
 * The user's local calendar date as a string, used by daily Page routes,
 * Nexus, and the notes API client.
 */

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

let calendar: { zone: string; formatter: Intl.DateTimeFormat } | null = null;

/** A server-valid zone can be absent from this browser’s timezone database. */
export function formatLocalDateInTimeZone(date: Date, timeZone: string): string | null {
  if (calendar?.zone !== timeZone) {
    try {
      const formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
      calendar = { zone: timeZone, formatter };
    } catch (error) {
      if (error instanceof RangeError) return null;
      throw error;
    }
  }
  const parts = calendar.formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new TypeError(
      "Unable to format a calendar date in the authenticated account time zone",
    );
  }
  return `${year.padStart(4, "0")}-${month}-${day}`;
}

export function isLocalDate(value: string): boolean {
  if (!LOCAL_DATE_RE.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T12:00:00Z`);
  return !value.startsWith("0000-") && Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function shiftLocalDate(value: string, days: number): string {
  if (!isLocalDate(value)) {
    return value;
  }
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const dayParts = new Intl.DateTimeFormat("en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** A civil display date can extend beyond the four-digit journal route range. */
export function calendarDateAtUtcNoon(date: string): Date {
  const iso = date.length > 10 ? `+${date.padStart(12, "0")}` : date;
  return new Date(`${iso}T12:00:00Z`);
}

/** A day's name: `Tuesday, 17 November`. Another year than `today`'s, or `today` unknown, adds the year. */
export function formatDay(date: string, today: string | null): string {
  const parts = Object.fromEntries(dayParts.formatToParts(calendarDateAtUtcNoon(date)).map(part => [part.type, part.value]));
  const day = `${parts.weekday}, ${parts.day} ${parts.month}`;
  return today !== null && today.slice(0, -6) === date.slice(0, -6) ? day : `${day} ${parts.year}`;
}

/** A recorded habit date, in full. */
export function habitDateLabel(date: string): string { return dayParts.format(new Date(`${date}T12:00:00Z`)); }
