/**
 * The Imports pane URL contract: the navigable state the pane reads through
 * `usePaneUrlState`, and the API query that state names. A URL is untrusted
 * input a reader can edit, so decoding is tolerant — an unreadable value is
 * simply absent — and canonicalizing, so the state can never name a
 * view/filter combination `GET /imports` answers with 400.
 */

import { absent, present, type Presence } from "@/lib/api/presence";
import { MEDIA_KINDS, type MediaKind } from "@/lib/media/kind";
import { isIsoInstant } from "@/lib/validation";
import {
  IMPORT_STAGES,
  IMPORT_STATE_KINDS,
  parseImportRef,
  type ImportRef,
  type ImportStage,
  type ImportStateKind,
} from "./importsClient";

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
  readonly failureCode: Presence<string>;
  readonly currentState: Presence<ImportStateKind>;
  readonly hadFailures: Presence<boolean>;
  readonly from: Presence<string>;
  readonly before: Presence<string>;
  readonly selected: Presence<ImportRef>;
}

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

function instant(raw: string | null): Presence<string> {
  return isIsoInstant(raw) ? present(new Date(raw).toISOString()) : absent();
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

/**
 * Drop the filters the chosen view cannot carry. `NeedsAttention` and
 * `InProgress` match the current state only, so dated history filters cannot
 * apply, and `InProgress` has no failure to name. A reason filter implies the
 * failure predicate, so `had_failures=false` beside one is the combination the
 * API answers with 400 — `had_failures=true` merely agrees with it and stays,
 * so the toolbar never silently unchecks what the reader set. An entry that has
 * not chosen a view yet keeps everything until the pane names one.
 */
function forView(state: ImportsUrlState): ImportsUrlState {
  const view = state.view;
  const failureCode =
    view.kind === "Present" && view.value === "InProgress"
      ? absent<string>()
      : state.failureCode;
  const historical = view.kind === "Absent" || view.value === "History";
  const contradicted =
    failureCode.kind === "Present" &&
    state.hadFailures.kind === "Present" &&
    !state.hadFailures.value;
  return {
    ...state,
    failureCode,
    currentState: historical ? state.currentState : absent(),
    hadFailures: historical && !contradicted ? state.hadFailures : absent(),
    from: historical ? state.from : absent(),
    before: historical ? state.before : absent(),
  };
}

export function decodeImportsUrlState(
  params: URLSearchParams,
): ImportsUrlState {
  return forView({
    view: oneOf(params.get("view"), IMPORTS_VIEWS),
    q: text(params.get("q")),
    mediaKind: oneOf(params.get("media_kind"), MEDIA_KINDS),
    stage: oneOf(params.get("stage"), IMPORT_STAGES),
    failureCode: text(params.get("failure_code")),
    currentState: oneOf(params.get("state"), IMPORT_STATE_KINDS),
    hadFailures: flag(params.get("had_failures")),
    from: instant(params.get("from")),
    before: instant(params.get("before")),
    selected: ref(params.get("selected")),
  });
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
  const normalized = forView(state);
  const params = filterParams(normalized);
  set(params, "selected", normalized.selected);
  return params;
}

/** The `GET /imports` query for the view the pane resolved. */
export function importsQueryParams(
  view: ImportsView,
  state: ImportsUrlState,
): URLSearchParams {
  return filterParams(forView({ ...state, view: present(view) }));
}
