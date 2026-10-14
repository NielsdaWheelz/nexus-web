import { isContributorHandle } from "@/lib/contributors/credits";
import {
  formatLocalDateInTimeZone,
  isLocalDate,
  shiftLocalDate,
} from "@/lib/localDate";
import { isCanonicalUuid } from "@/lib/validation";

// The Stats pane's url is only what the viewer chose: an absent period is the day, an absent
// anchor is today (so a pane left open follows the date), an absent year this year. Dates are
// civil dates in the browser's calendar; only the request resolves them in its time zone.
// Nothing rewrites the url in place.

export type StatsPeriod = "day" | "week" | "month" | "year" | "all";
export type FilterKey = "modality" | "media" | "contributor" | "device";
export interface StatsView {
  view: "stats" | "year";
  period: StatsPeriod;
  anchor: string | null;
  year: number | null;
  filters: Partial<Record<FilterKey, string>>;
}

export const PERIOD_LABEL = {
  day: "Day",
  week: "Week",
  month: "Month",
  year: "Year",
  all: "All time",
};
const BUCKET = {
  day: "Hour",
  week: "Day",
  month: "Day",
  year: "Month",
  all: "Year",
} as const;
const QUERY_KEY = {
  modality: "modality",
  media: "media_id",
  contributor: "contributor_handle",
  device: "device_id",
};
const VALID: Record<FilterKey, (value: string) => boolean> = {
  modality: (value) => ["Reading", "Listening", "Viewing"].includes(value),
  media: isCanonicalUuid,
  contributor: isContributorHandle,
  device: (value) => value.length > 0 && value.length <= 200,
};

export const browserToday = () =>
  formatLocalDateInTimeZone(
    new Date(),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );

/** Invalid values read as absent. The year view keeps only its year. */
export function readStatsView(params: URLSearchParams): StatsView {
  const get = (key: string) => params.get(key) ?? "";
  const thisYear = Number(browserToday().slice(0, 4));
  if (get("view") === "year") {
    const year = Number(get("year"));
    const valid = Number.isInteger(year) && year >= 1970 && year <= thisYear;
    return {
      view: "year",
      period: "year",
      anchor: null,
      year: valid ? year : null,
      filters: {},
    };
  }
  const filters: StatsView["filters"] = {};
  for (const key of Object.keys(VALID) as FilterKey[])
    if (VALID[key](get(key))) filters[key] = get(key);
  return {
    view: "stats",
    period: Object.hasOwn(BUCKET, get("period"))
      ? (get("period") as StatsPeriod)
      : "day",
    anchor: isLocalDate(get("anchor")) ? get("anchor") : null,
    year: null,
    filters,
  };
}

export function statsViewHref(view: StatsView): string {
  const params = new URLSearchParams();
  if (view.view === "year") {
    params.set("view", "year");
    if (view.year !== null) params.set("year", `${view.year}`);
  } else {
    for (const [key, value] of Object.entries(view.filters))
      if (value) params.set(key, value);
    if (view.period !== "day") params.set("period", view.period);
    if (view.anchor !== null) params.set("anchor", view.anchor);
  }
  const query = params.toString();
  return query ? `/stats?${query}` : "/stats";
}

/** The first day of the period holding `date`: its Monday, 1st or January 1st. */
export function periodStart(date: string, period: StatsPeriod): string {
  if (period === "month") return `${date.slice(0, 8)}01`;
  if (period === "year") return `${date.slice(0, 4)}-01-01`;
  if (period !== "week") return date;
  return shiftLocalDate(
    date,
    1 - (new Date(`${date}T00:00:00Z`).getUTCDay() || 7),
  );
}

export function shiftAnchor(
  anchor: string,
  period: StatsPeriod,
  amount: number,
): string {
  if (period === "day" || period === "week")
    return shiftLocalDate(anchor, period === "week" ? amount * 7 : amount);
  const [year, month] = anchor.split("-").map(Number);
  const shifted =
    period === "year"
      ? Date.UTC(year + amount, 0)
      : Date.UTC(year, month - 1 + amount);
  return new Date(shifted).toISOString().slice(0, 10);
}

/** The Stats query of a view: its range in `timeZone`, bucket grain and filters. */
export function statsQuery(view: StatsView, timeZone: string): URLSearchParams {
  const today = formatLocalDateInTimeZone(new Date(), timeZone);
  const period = view.view === "year" ? "year" : view.period;
  const query = new URLSearchParams({
    time_zone: timeZone,
    bucket: BUCKET[period],
  });
  if (period === "all") {
    query.set("end", shiftLocalDate(today, 1));
  } else {
    const anchor =
      view.view === "year"
        ? `${view.year ?? today.slice(0, 4)}-01-01`
        : (view.anchor ?? today);
    const start = periodStart(anchor, period);
    query.set("start", start);
    query.set("end", shiftAnchor(start, period, 1));
  }
  for (const [key, value] of Object.entries(view.filters))
    if (value) query.set(QUERY_KEY[key as FilterKey], value);
  return query;
}
