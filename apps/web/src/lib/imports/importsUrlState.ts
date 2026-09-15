/**
 * The Imports pane URL contract: the navigable state the pane reads through
 * `usePaneUrlState`, and the API query that state names. A URL is untrusted
 * input a reader can edit, so decoding is tolerant — an unreadable or
 * uncatalogued value is simply absent — and it keeps everything the reader did
 * write, including the History filters another view cannot correlate. Narrowing
 * to what a view can carry happens where it matters: in the API query, which can
 * never name a combination `GET /imports` answers with 400.
 */

import { absent, present, type Presence } from "@/lib/api/presence";
import {
  IMPORT_STAGES,
  IMPORT_STATE_KINDS,
  SAFE_FAILURE_CODES,
  parseImportRef,
  type ImportRef,
  type ImportStage,
  type ImportStateKind,
  type SafeFailureCode,
} from "@/lib/imports/importRef";
import { MEDIA_KINDS, type MediaKind } from "@/lib/media/kind";

export const IMPORTS_VIEWS = [
  "NeedsAttention",
  "InProgress",
  "History",
] as const;
export type ImportsView = (typeof IMPORTS_VIEWS)[number];

export interface ImportsUrlState {
  readonly view: Presence<ImportsView>;
  readonly q: Presence<string>;
  readonly mediaKind: Presence<MediaKind>;
  readonly stage: Presence<ImportStage>;
  readonly failureCode: Presence<SafeFailureCode>;
  readonly currentState: Presence<ImportStateKind>;
  readonly hadFailures: Presence<boolean>;
  /** UTC calendar days, `[from, before)` (contract D17). */
  readonly from: Presence<string>;
  readonly before: Presence<string>;
  readonly selected: Presence<ImportRef>;
}

const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function oneOf<T extends string>(
  raw: string | null,
  values: readonly T[],
): Presence<T> {
  const value = values.find((candidate) => candidate === raw);
  return value === undefined ? absent() : present(value);
}

function text(raw: string | null): Presence<string> {
  const value = raw?.trim() ?? "";
  return value.length === 0 ? absent() : present(value);
}

/**
 * A `<input type="date">` value: a UTC calendar day. The round trip through
 * `Date` rejects a well-formed but impossible day (`2026-09-31`), which the
 * pattern alone accepts.
 */
function calendarDate(raw: string | null): Presence<string> {
  if (raw === null || !CALENDAR_DATE_RE.test(raw)) return absent();
  const instant = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(instant.getTime()) ||
    instant.toISOString().slice(0, 10) !== raw
    ? absent()
    : present(raw);
}

function flag(raw: string | null): Presence<boolean> {
  if (raw === "true") return present(true);
  if (raw === "false") return present(false);
  return absent();
}

function ref(raw: string | null): Presence<ImportRef> {
  const parsed = raw === null ? null : parseImportRef(raw);
  return parsed === null ? absent() : present(parsed);
}

export function decodeImportsUrlState(
  params: URLSearchParams,
): ImportsUrlState {
  return {
    view: oneOf(params.get("view"), IMPORTS_VIEWS),
    q: text(params.get("q")),
    mediaKind: oneOf(params.get("media_kind"), MEDIA_KINDS),
    stage: oneOf(params.get("stage"), IMPORT_STAGES),
    failureCode: oneOf(params.get("failure_code"), SAFE_FAILURE_CODES),
    currentState: oneOf(params.get("state"), IMPORT_STATE_KINDS),
    hadFailures: flag(params.get("had_failures")),
    from: calendarDate(params.get("from")),
    before: calendarDate(params.get("before")),
    selected: ref(params.get("selected")),
  };
}

function set(
  params: URLSearchParams,
  name: string,
  value: Presence<string | boolean>,
): void {
  if (value.kind === "Present") params.set(name, String(value.value));
}

/** The one canonical parameter order, shared by the pane URL and the API query. */
function filterParams(state: ImportsUrlState): URLSearchParams {
  const params = new URLSearchParams();
  set(params, "view", state.view);
  set(params, "q", state.q);
  set(params, "media_kind", state.mediaKind);
  set(params, "stage", state.stage);
  set(params, "failure_code", state.failureCode);
  set(params, "state", state.currentState);
  set(params, "had_failures", state.hadFailures);
  set(params, "from", state.from);
  set(params, "before", state.before);
  return params;
}

export function encodeImportsUrlState(
  state: ImportsUrlState,
  _currentParams: URLSearchParams,
): URLSearchParams {
  const params = filterParams(state);
  set(params, "selected", state.selected);
  return params;
}

/**
 * The `GET /imports` query for the view the pane resolved. `NeedsAttention` and
 * `InProgress` match the current state only, so dated history filters cannot
 * apply, and `InProgress` has no failure to name. A reason filter implies the
 * failure predicate, so `had_failures=false` beside one is the combination the
 * API answers with 400; `had_failures=true` merely agrees with it and stays.
 * The bounds are calendar days in the URL and explicit UTC instants here.
 */
export function importsQueryParams(
  view: ImportsView,
  state: ImportsUrlState,
): URLSearchParams {
  const failureCode =
    view === "InProgress" ? absent<SafeFailureCode>() : state.failureCode;
  const historical = view === "History";
  const contradicted =
    failureCode.kind === "Present" &&
    state.hadFailures.kind === "Present" &&
    !state.hadFailures.value;
  const params = filterParams({
    ...state,
    view: present(view),
    failureCode,
    currentState: historical ? state.currentState : absent(),
    hadFailures: historical && !contradicted ? state.hadFailures : absent(),
    from: absent(),
    before: absent(),
  });
  if (historical) {
    for (const [name, bound] of [
      ["from", state.from],
      ["before", state.before],
    ] as const) {
      if (bound.kind === "Present") params.set(name, `${bound.value}T00:00:00Z`);
    }
  }
  return params;
}
