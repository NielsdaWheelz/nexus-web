import type { RenderEnvironment } from "@/lib/renderEnvironment/types";

type DisplayFormatContext = Pick<
  RenderEnvironment,
  "displayLocale" | "displayTimeZone"
>;

export function formatDisplayDate(
  value: string | Date,
  context: DisplayFormatContext,
  options?: Intl.DateTimeFormatOptions,
): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(context.displayLocale, {
    timeZone: context.displayTimeZone,
    ...options,
  }).format(date);
}

export function formatDisplayNumber(
  value: number,
  context: Pick<RenderEnvironment, "displayLocale">,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(context.displayLocale, options).format(value);
}

const RELATIVE_TIME_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 60 * 60 * 24 * 365],
  ["month", 60 * 60 * 24 * 30],
  ["week", 60 * 60 * 24 * 7],
  ["day", 60 * 60 * 24],
  ["hour", 60 * 60],
  ["minute", 60],
  ["second", 1],
];

// `now` is a parameter so this function stays pure and deterministic: callers
// thread the current time, keeping it testable rather than reading the clock.
export function formatRelativeTime(
  value: string | Date,
  context: Pick<RenderEnvironment, "displayLocale">,
  now: Date,
): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const seconds = (date.getTime() - now.getTime()) / 1000;
  const formatter = new Intl.RelativeTimeFormat(context.displayLocale, {
    numeric: "auto",
  });
  for (const [unit, secondsPerUnit] of RELATIVE_TIME_UNITS) {
    if (Math.abs(seconds) >= secondsPerUnit || unit === "second") {
      return formatter.format(Math.round(seconds / secondsPerUnit), unit);
    }
  }
  return null;
}

export function compareStableString(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
