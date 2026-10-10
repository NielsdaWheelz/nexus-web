/**
 * The Imports pane url and the api query it names. A url is input a reader can
 * edit, so decoding is tolerant (an unreadable or uncatalogued value is absent)
 * and keeps whatever the reader wrote, History filters included while another
 * view is open. Narrowing to what a view correlates happens in `apiQuery`,
 * which never names a combination `GET /imports` answers with 400.
 */

import type {
  ImportState,
  ImportStage,
  ImportSummary,
  ImportsView,
  SafeFailureCode,
} from "@/lib/imports/api";
import {
  FAILURE_COPY,
  KIND_LABEL,
  SAFE_FAILURE_CODES,
  STAGE_COPY,
  STATE_KIND_LABEL,
  dateChipLabel,
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
  readonly failure_code?: SafeFailureCode;
  readonly state?: ImportState["kind"];
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
export const STATE_KINDS = Object.keys(
  STATE_KIND_LABEL,
) as ImportState["kind"][];

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

const HISTORY_WINDOW_DAYS = 30;

/**
 * An import ref as one path segment of `/api/imports/{ref}`: the prefix keeps
 * it off `summary`, `.` and `..`, and no slash lets it reach another route.
 */
const IMPORT_REF = /^(upload|media):[^/]+$/;

export function oneOf<T extends string>(
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
    failure_code: oneOf(params.get("failure_code"), SAFE_FAILURE_CODES),
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
 * The `GET /imports` query for the view the pane resolved. Needs attention and
 * In progress match the current state only, so History's state, failure and
 * date filters cannot apply, and In progress has no failure to name. A reason
 * implies the failure predicate, so `had_failures=false` beside one (a 400) is
 * dropped. Days become explicit UTC instants.
 */
export function apiQuery(view: ImportsView, state: ImportsUrlState): string {
  const history = view === "History";
  const failure = view === "InProgress" ? undefined : state.failure_code;
  const contradicted = failure !== undefined && state.had_failures === false;
  const instant = (day: string | undefined) =>
    history && day !== undefined ? `${day}T00:00:00Z` : undefined;
  return encodeImportsUrl({
    view,
    q: state.q,
    media_kind: state.media_kind,
    stage: state.stage,
    failure_code: failure,
    state: history ? state.state : undefined,
    had_failures: history && !contradicted ? state.had_failures : undefined,
    from: instant(state.from),
    before: instant(state.before),
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

/** Whether Reset view would change nothing the reader can see. */
export function isDefaultView(
  state: ImportsUrlState,
  view: ImportsView,
  today: string,
): boolean {
  const reset = selectView(
    withoutFilters({ ...state, q: undefined }),
    view,
    today,
  );
  return FILTERS.every((name) => state[name] === reset[name]);
}

/** History dates bound the failure event when the query asks about failures. */
export function dateBounds(state: ImportsUrlState): DateBounds {
  return state.had_failures === true || state.failure_code !== undefined
    ? "Failure"
    : "AnyEvent";
}

/**
 * The filters this view applies. A History-only filter stays in the url while
 * another view is open, but is not claimed by a view that cannot correlate it.
 */
export function appliedFilters(
  view: ImportsView,
  state: ImportsUrlState,
  locale: string,
): { readonly id: ImportsFilter; readonly label: string }[] {
  const chips: { id: ImportsFilter; label: string }[] = [];
  const chip = (id: ImportsFilter, label: string) => chips.push({ id, label });
  if (state.q !== undefined) chip("q", `Search: ${state.q}`);
  if (state.media_kind !== undefined) {
    chip("media_kind", `Type: ${KIND_LABEL[state.media_kind]}`);
  }
  if (state.stage !== undefined)
    chip("stage", `Stage: ${stageLabel(state.stage)}`);
  if (state.failure_code !== undefined && view !== "InProgress") {
    chip("failure_code", `Reason: ${FAILURE_COPY[state.failure_code].reason}`);
  }
  if (view !== "History") return chips;
  if (state.state !== undefined) {
    chip("state", `State: ${STATE_KIND_LABEL[state.state]}`);
  }
  if (state.had_failures !== undefined) {
    chip(
      "had_failures",
      state.had_failures ? "Had failures" : "No recorded failures",
    );
  }
  const bounds = dateBounds(state);
  if (state.from !== undefined) {
    chip("from", dateChipLabel(bounds, "From", state.from, locale));
  }
  if (state.before !== undefined) {
    chip("before", dateChipLabel(bounds, "Before", state.before, locale));
  }
  return chips;
}

/** Clears the structured filters; the view, the search and the selection stay. */
export function withoutFilters(state: ImportsUrlState): ImportsUrlState {
  return { view: state.view, q: state.q, selected: state.selected };
}
