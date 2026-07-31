/**
 * Local-date helpers (YYYY-MM-DD).
 *
 * The user's local calendar date as a string, used by daily Page routes,
 * Nexus, and the notes API client.
 */

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function formatLocalDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new TypeError(
      "Unable to format a calendar date in the authenticated account time zone",
    );
  }
  return `${year}-${month}-${day}`;
}

export function isLocalDate(value: string): boolean {
  if (!LOCAL_DATE_RE.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);
  return (
    parsed.getFullYear() === year &&
    parsed.getMonth() === month - 1 &&
    parsed.getDate() === day
  );
}

export function shiftLocalDate(value: string, days: number): string {
  if (!isLocalDate(value)) {
    return value;
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}
