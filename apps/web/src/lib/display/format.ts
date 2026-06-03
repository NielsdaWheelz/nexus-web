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

export function compareStableString(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
