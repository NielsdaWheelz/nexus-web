import type { Schema } from "@/lib/api/wire";
import { formatDisplayDate } from "@/lib/display/format";
import { shiftLocalDate } from "@/lib/localDate";
import { pluralize } from "@/lib/text/pluralize";

/** Observed time has one spelling in the pane, reader and copied record. */
export function recordTime(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

/** A wire date is a civil day, never an instant in the browser's zone. */
export function recordDate(date: string): string {
  return formatDisplayDate(date, { displayLocale: "en", displayTimeZone: "UTC" }, {
    day: "numeric", month: "short", year: "numeric",
  })!.toLowerCase();
}

/** Finishing before the first observation is two dated facts, not a reversed interval. */
export function recordDateClause(first: string, finished: string, separator: "to" | "–"): string {
  return first > finished ? `since ${recordDate(first)}; finished ${recordDate(finished)}`
    : `${recordDate(first)} ${separator} ${recordDate(finished)}`;
}

/** The caller offers a finished work only when it has a completion fact. */
export function workRecordText(record: Schema<"WorkRecordOut">, title: string): string {
  const finished = record.finished_on;
  // justify-defect: a work without a completion fact has no finished record to copy.
  if (finished === null) throw new Error("a copied work needs a finish date");
  const first = record.first_read_on ?? finished;
  const lines = [
    `nexus · ${title}, finished`,
    `${pluralize(record.sittings, "sitting")} · ${recordDateClause(first, finished, "–")} · ${recordTime(record.active_ms)}`,
  ];
  if (record.sittings > 0) {
    const days = new Map(record.days.map(day => [day.date, day.active_ms]));
    const fullest = Math.max(...record.days.map(day => day.active_ms));
    let blocks = "";
    for (let date = first < finished ? first : finished; date <= finished; date = shiftLocalDate(date, 1)) {
      const active = days.get(date) ?? 0;
      blocks += active > 0 ? String.fromCharCode(0x2581 + Math.min(7, Math.round(active / fullest * 7))) : "·";
    }
    lines.push(`${blocks}❦`);
  }
  return lines.join("\n");
}

export function stackRecordText(stack: Schema<"StackYearOut">, days: readonly Schema<"DayOut">[]): string {
  const active = days.filter(day => Number(day.date.slice(0, 4)) === stack.year)
    .reduce((sum, day) => sum + day.active_ms, 0);
  return `nexus · ${stack.year}, the stack\n${pluralize(stack.works.length, "work")} · ${(stack.height_mm / 10).toFixed(1)} cm · ${recordTime(active)} observed`;
}
