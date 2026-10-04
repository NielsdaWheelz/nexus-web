import type { PaneUrlStateCodec } from "@/lib/api/usePaneUrlState";
import type { ActivityModality } from "@/lib/consumption/activityContract";
import { tryParseContributorHandle } from "@/lib/contributors/handle";
import { formatLocalDateInTimeZone, isLocalDate, shiftLocalDate } from "@/lib/localDate";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";

// The pane's URL state and periods are civil dates in the browser's calendar; only a request
// resolves them to instants, in the query time zone.

export type StatsPeriod = "day" | "week" | "month" | "year" | "all";
export type FilterKey = keyof typeof FILTER_PARAM;

export interface StatsUrlState {
  view: "stats" | "year";
  period: StatsPeriod;
  anchor: string;
  year: number;
  filters: { modality?: ActivityModality; media?: string; contributor?: string; device?: string };
}

const BUCKET = { day: "Hour", week: "Day", month: "Day", year: "Month", all: "Year" } as const;
const FILTER_PARAM = {
  modality: "modality",
  media: "mediaRef",
  contributor: "contributorHandle",
  device: "deviceHandle",
} as const;
const FILTER_KEYS = Object.keys(FILTER_PARAM) as FilterKey[];

export const browserToday = () =>
  formatLocalDateInTimeZone(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone);

/** Invalid or missing values fall back to today's day view; the year view keeps only its year. */
export const statsUrlCodec: PaneUrlStateCodec<StatsUrlState> = {
  basePath: "/stats",
  decode(params) {
    const get = (key: string) => params.get(key) ?? "";
    const today = browserToday();
    const thisYear = Number(today.slice(0, 4));
    if (get("view") === "year") {
      const asked = Number(get("year"));
      const year = Number.isInteger(asked) && asked >= 1970 && asked <= thisYear ? asked : thisYear;
      return { view: "year", period: "year", anchor: `${year}-01-01`, year, filters: {} };
    }
    const modality = get("modality");
    const contributor = tryParseContributorHandle(get("contributor"));
    const filters: StatsUrlState["filters"] = {};
    if (["Reading", "Listening", "Viewing"].includes(modality)) {
      filters.modality = modality as ActivityModality;
    }
    if (parseResourceRef(get("media"))?.scheme === "media") filters.media = get("media");
    if (contributor) filters.contributor = contributor;
    if (/^ncd1\.[A-Za-z0-9_-]{22}$/.test(get("device"))) filters.device = get("device");
    return {
      view: "stats",
      period: Object.hasOwn(BUCKET, get("period")) ? (get("period") as StatsPeriod) : "day",
      anchor: isLocalDate(get("anchor")) ? get("anchor") : today,
      year: thisYear,
      filters,
    };
  },
  encode(state) {
    if (state.view === "year") return new URLSearchParams({ view: "year", year: `${state.year}` });
    const params = new URLSearchParams({ view: "stats" });
    for (const key of FILTER_KEYS) {
      const value = state.filters[key];
      if (value) params.set(key, value);
    }
    params.set("period", state.period);
    params.set("anchor", state.anchor);
    return params;
  },
};

/** The first day of the period holding `date`: its Monday, 1st or January 1st. */
export function periodStart(date: string, period: StatsPeriod): string {
  if (period === "month") return `${date.slice(0, 8)}01`;
  if (period === "year") return `${date.slice(0, 4)}-01-01`;
  if (period !== "week") return date;
  return shiftLocalDate(date, 1 - (new Date(`${date}T00:00:00Z`).getUTCDay() || 7));
}

export function shiftAnchor(anchor: string, period: StatsPeriod, amount: number): string {
  if (period === "day" || period === "week") {
    return shiftLocalDate(anchor, period === "week" ? amount * 7 : amount);
  }
  const [year, month] = anchor.split("-").map(Number);
  const shifted =
    period === "year" ? Date.UTC(year + amount, 0) : Date.UTC(year, month - 1 + amount);
  return new Date(shifted).toISOString().slice(0, 10);
}

/** The Stats query of a view: its range in `timeZone`, bucket grain and filters. */
export function statsQuery(state: StatsUrlState, timeZone: string): URLSearchParams {
  const period = state.view === "year" ? "year" : state.period;
  const query = new URLSearchParams({ timeZone, bucket: BUCKET[period] });
  if (period === "all") {
    const tomorrow = shiftLocalDate(formatLocalDateInTimeZone(new Date(), timeZone), 1);
    query.set("end", tomorrow);
  } else {
    const start = periodStart(state.anchor, period);
    query.set("start", start);
    query.set("end", shiftAnchor(start, period, 1));
  }
  for (const key of FILTER_KEYS) {
    const value = state.filters[key];
    if (value) query.set(FILTER_PARAM[key], value);
  }
  return query;
}
