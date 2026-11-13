/**
 * Local-date helpers (YYYY-MM-DD).
 *
 * The user's local calendar date as a string, used by daily Page routes,
 * Nexus, and the notes API client.
 */

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A server-valid zone can be absent from this browser’s timezone database. */
export function formatLocalDateInTimeZone(date: Date, timeZone: string): string | null {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  const parts = formatter.formatToParts(date);
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
