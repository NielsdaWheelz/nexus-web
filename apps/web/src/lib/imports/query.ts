/**
 * The Imports pane url and the api query it names. A url is input a reader can
 * edit, so decoding is tolerant (an unreadable or uncatalogued value is absent)
 * and keeps what the reader wrote, History filters included while another view
 * is open. `VIEW_FILTERS` is the one statement of what a view correlates: the
 * toolbar offers it, the chips show it and `apiQuery` sends it, so no
 * combination `GET /imports` refuses is ever sent.
 */

import type {
  Classification,
  ImportFailureCode,
  ImportStage,
  ImportSummary,
  ImportsView,
} from "@/lib/imports/api";
import {
  IMPORT_FAILURE_CODES,
  KIND_LABEL,
  STAGE_COPY,
  STATE_KIND_LABEL,
  dateChipLabel,
  failureFilterLabel,
  stageLabel,
  type DateBounds,
} from "@/lib/imports/copy";
import { isLocalDate, shiftLocalDate } from "@/lib/localDate";
import { MEDIA_KINDS, type MediaKind } from "@/lib/media/kind";

/** Url params by their wire names. Dates are UTC days, `[from, before)`. */
export interface ImportsUrlState {
  readonly view?: ImportsView;
  readonly q?: string;
  readonly media_kind?: MediaKind;
  readonly stage?: ImportStage;
  readonly failure_code?: ImportFailureCode;
  readonly state?: Classification;
  readonly had_failures?: boolean;
  readonly from?: string;
  readonly before?: string;
  /** The inspected import's ref (`IMPORT_REF`; the server owns the rest). */
  readonly selected?: string;
}

export type ImportsFilter = Exclude<keyof ImportsUrlState, "view" | "selected">;

export const IMPORTS_VIEWS: readonly ImportsView[] = [
  "NeedsAttention",
  "InProgress",
  "History",
];
// justify-type-assertion: the keys of Records exhaustive over these unions.
export const IMPORT_STAGES = Object.keys(STAGE_COPY) as ImportStage[];
export const STATE_KINDS = Object.keys(STATE_KIND_LABEL) as Classification[];

/** The one canonical parameter order, for the pane url and the api query. */
const PARAMS = [
  "view",
  "q",
  "media_kind",
  "stage",
  "failure_code",
  "state",
  "had_failures",
  "from",
  "before",
  "selected",
] as const satisfies readonly (keyof ImportsUrlState)[];

const FILTERS = PARAMS.filter(
  (name): name is ImportsFilter => name !== "view" && name !== "selected",
);

/**
 * What each view correlates: Needs attention and In progress a current
 * obligation (In progress has no failure to name), History one recorded event.
 */
export const VIEW_FILTERS: Readonly<
  Record<ImportsView, readonly ImportsFilter[]>
> = {
  NeedsAttention: ["q", "media_kind", "stage", "failure_code"],
  InProgress: ["q", "media_kind", "stage"],
  History: FILTERS,
};

const HISTORY_WINDOW_DAYS = 30;

/**
 * An import ref as one path segment of `/api/imports/{ref}`: the prefix keeps
 * it off `summary`, `.` and `..`, and no slash lets it reach another route.
 */
const IMPORT_REF = /^(upload|media):[^/]+$/;

function oneOf<T extends string>(
  raw: string | null,
  values: readonly T[],
): T | undefined {
  return values.find((value) => value === raw);
}

export function decodeImportsUrl(params: URLSearchParams): ImportsUrlState {
  const day = (name: string) => {
    const raw = params.get(name);
    return raw !== null && isLocalDate(raw) ? raw : undefined;
  };
  const flag = params.get("had_failures");
  const selected = params.get("selected");
  return {
    view: oneOf(params.get("view"), IMPORTS_VIEWS),
    q: params.get("q")?.trim() || undefined,
    media_kind: oneOf(params.get("media_kind"), MEDIA_KINDS),
    stage: oneOf(params.get("stage"), IMPORT_STAGES),
    failure_code: oneOf(params.get("failure_code"), IMPORT_FAILURE_CODES),
    state: oneOf(params.get("state"), STATE_KINDS),
    had_failures: flag === "true" ? true : flag === "false" ? false : undefined,
    from: day("from"),
    before: day("before"),
    selected:
      selected !== null && IMPORT_REF.test(selected) ? selected : undefined,
  };
}

export function encodeImportsUrl(state: ImportsUrlState): URLSearchParams {
  const params = new URLSearchParams();
  for (const name of PARAMS) {
    const value = state[name];
    if (value !== undefined) params.set(name, String(value));
  }
  return params;
}

/**
 * The filters `view` applies: its own, without a "no recorded failures" that a
 * reason contradicts (only a hand-edited url holds both; `withFilter` never
 * writes them together).
 */
export function appliedState(
  view: ImportsView,
  state: ImportsUrlState,
): ImportsUrlState {
  const applies = (name: ImportsFilter) => VIEW_FILTERS[view].includes(name);
  const failure = applies("failure_code") ? state.failure_code : undefined;
  const hadFailures = applies("had_failures") ? state.had_failures : undefined;
  return {
    q: applies("q") ? state.q : undefined,
    media_kind: applies("media_kind") ? state.media_kind : undefined,
    stage: applies("stage") ? state.stage : undefined,
    failure_code: failure,
    state: applies("state") ? state.state : undefined,
    had_failures:
      failure !== undefined && hadFailures === false ? undefined : hadFailures,
    from: applies("from") ? state.from : undefined,
    before: applies("before") ? state.before : undefined,
  };
}

/**
 * One filter set (or cleared, by "") through the tolerant decoder. Of a reason
 * and "no recorded failures", the latest choice wins.
 */
export function withFilter(
  state: ImportsUrlState,
  name: ImportsFilter,
  value: string,
): ImportsUrlState {
  const params = encodeImportsUrl(state);
  if (value === "") params.delete(name);
  else params.set(name, value);
  if (name === "failure_code" && value !== "" && state.had_failures === false)
    params.delete("had_failures");
  if (name === "had_failures" && value === "false")
    params.delete("failure_code");
  return decodeImportsUrl(params);
}

/** The `GET /imports` query: the applied filters, days as UTC instants. */
export function apiQuery(view: ImportsView, state: ImportsUrlState): string {
  const applied = appliedState(view, state);
  const instant = (day: string | undefined) =>
    day === undefined ? undefined : `${day}T00:00:00Z`;
  return encodeImportsUrl({
    ...applied,
    view,
    from: instant(applied.from),
    before: instant(applied.before),
  }).toString();
}

/**
 * The view an entry without one lands on: attention, else active work, else
 * History. Until the counts are known no view is chosen, so the reader is
 * never moved off one when they arrive.
 */
export function firstView(summary: ImportSummary | null): ImportsView | null {
  if (summary === null) return null;
  if (summary.needs_attention_count > 0) return "NeedsAttention";
  return summary.active_count > 0 ? "InProgress" : "History";
}

/**
 * The state the pane navigates to when it selects a view. History writes its
 * visible 30-day window into the url, anchored on the reader's own day.
 */
export function selectView(
  state: ImportsUrlState,
  view: ImportsView,
  today: string,
): ImportsUrlState {
  const from =
    view === "History" && state.from === undefined
      ? shiftLocalDate(today, -HISTORY_WINDOW_DAYS)
      : state.from;
  return { ...state, view, from };
}

/** Clears the structured filters; the view, the search and the selection stay. */
export function withoutFilters(state: ImportsUrlState): ImportsUrlState {
  return { view: state.view, q: state.q, selected: state.selected };
}

/** Reset view: no search, no filters, the view's own default window. */
export function resetView(
  state: ImportsUrlState,
  view: ImportsView,
  today: string,
): ImportsUrlState {
  return selectView(withoutFilters({ ...state, q: undefined }), view, today);
}

/** Whether Reset view would change nothing the reader can see. */
export function isDefaultView(
  state: ImportsUrlState,
  view: ImportsView,
  today: string,
): boolean {
  const reset = resetView(state, view, today);
  return FILTERS.every((name) => state[name] === reset[name]);
}

/** History dates bound the failure event when the query asks about failures. */
export function dateBounds(state: ImportsUrlState): DateBounds {
  return state.had_failures === true || state.failure_code !== undefined
    ? "Failure"
    : "AnyEvent";
}

/** The chips of the filters `view` applies, in parameter order. */
export function appliedFilters(
  view: ImportsView,
  state: ImportsUrlState,
  locale: string,
): { readonly id: ImportsFilter; readonly label: string }[] {
  const applied = appliedState(view, state);
  const bounds = dateBounds(applied);
  const chips: { id: ImportsFilter; label: string }[] = [];
  const chip = (id: ImportsFilter, label: string) => chips.push({ id, label });
  if (applied.q !== undefined) chip("q", `Search: ${applied.q}`);
  if (applied.media_kind !== undefined)
    chip("media_kind", `Type: ${KIND_LABEL[applied.media_kind]}`);
  if (applied.stage !== undefined)
    chip("stage", `Stage: ${stageLabel(applied.stage)}`);
  if (applied.failure_code !== undefined)
    chip("failure_code", `Reason: ${failureFilterLabel(applied.failure_code)}`);
  if (applied.state !== undefined)
    chip("state", `State: ${STATE_KIND_LABEL[applied.state]}`);
  if (applied.had_failures !== undefined)
    chip(
      "had_failures",
      applied.had_failures ? "Recorded failures" : "No recorded failures",
    );
  if (applied.from !== undefined)
    chip("from", dateChipLabel(bounds, "From", applied.from, locale));
  if (applied.before !== undefined)
    chip("before", dateChipLabel(bounds, "Before", applied.before, locale));
  return chips;
}
