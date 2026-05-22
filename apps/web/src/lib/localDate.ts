/**
 * Local-date helpers (YYYY-MM-DD).
 *
 * The user's local calendar date as a string, used by daily-note routes,
 * the command palette, and the notes API client.
 */

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function todayLocalDate(): string {
  return formatLocalDate(new Date());
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
