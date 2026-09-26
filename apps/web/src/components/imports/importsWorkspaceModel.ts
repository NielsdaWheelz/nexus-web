/**
 * The pure view model of the Imports workspace: which view an unqualified entry
 * lands on, the badge the navigation shows, how rows group under a stage, how
 * recorded events group into attempts, and which filters are currently applied.
 * Nothing here reads or writes; the workspace renders what it returns
 * (contract §6).
 */

import { absent, present } from "@/lib/api/presence";
import { assertNever } from "@/lib/assertNever";
import type { ImportStage } from "@/lib/imports/importRef";
import type {
  HistoryEntry,
  HistoryFacts,
  ImportItem,
  ImportStageGroup,
  ImportSummary,
} from "@/lib/imports/importsClient";
import type {
  ImportsUrlState,
  ImportsView,
} from "@/lib/imports/importsUrlState";
import { shiftLocalDate } from "@/lib/localDate";
import {
  IMPORT_FAILURE_COPY,
  IMPORT_STATE_KIND_LABEL,
  importKindLabel,
  importStageLabel,
  importsAttentionPhrase,
  importsDateChipLabel,
  type ImportsDateBounds,
} from "@/lib/status/imports";

export const IMPORTS_VIEW_LABEL: Readonly<Record<ImportsView, string>> = {
  NeedsAttention: "Needs attention",
  InProgress: "In progress",
  History: "History",
};

const HISTORY_DEFAULT_WINDOW_DAYS = 30;
const VISIBLE_COUNT_CAP = 99;

/**
 * A count as every surface prints it. One cap for the navigation badge and the
 * view tabs, so the same number can never read as `99+` in one place and `150`
 * in another; the exact number stays in the accessible name.
 */
export function importsCountText(count: number): string {
  return count > VISIBLE_COUNT_CAP ? `${VISIBLE_COUNT_CAP}+` : String(count);
}

/**
 * The view an entry without an explicit `view` lands on: attention when it is
 * nonempty, otherwise active work, otherwise History. Until the summary is
 * known no view has been chosen, and choosing one early would flip the reader
 * off it the moment the counts arrive.
 */
export function unqualifiedImportsView(
  summary: ImportSummary | null,
): ImportsView | null {
  if (summary === null) return null;
  if (summary.needsAttentionCount > 0) return "NeedsAttention";
  if (summary.activeCount > 0) return "InProgress";
  return "History";
}

/**
 * The state the pane navigates to when it selects a view itself. Selecting
 * History materializes the visible 30-day window into the URL, anchored on the
 * reader's own current day so a tab open past midnight in their zone still asks
 * for the thirty days they can see (D17); every other view keeps what the
 * reader wrote.
 */
export function importsViewSelection(
  state: ImportsUrlState,
  view: ImportsView,
  today: string,
): ImportsUrlState {
  const dated = view === "History" && state.from.kind === "Absent";
  return {
    ...state,
    view: present(view),
    from: dated
      ? present(shiftLocalDate(today, -HISTORY_DEFAULT_WINDOW_DAYS))
      : state.from,
  };
}

export type ImportsBadge =
  | { readonly kind: "Hidden" }
  | {
      readonly kind: "Count";
      readonly visible: string;
      readonly accessible: string;
    };

/**
 * The navigation badge. It counts imports needing attention and nothing else:
 * zero hides it, an unknown summary is not zero, and a large count is capped
 * visually while the accessible name keeps the exact number.
 */
export function importsBadge(summary: ImportSummary | null): ImportsBadge {
  if (summary === null || summary.needsAttentionCount === 0) {
    return { kind: "Hidden" };
  }
  const count = summary.needsAttentionCount;
  return {
    kind: "Count",
    visible: importsCountText(count),
    accessible: importsAttentionPhrase(count),
  };
}

export interface ImportStageSection {
  readonly stage: ImportStage;
  readonly count: number;
  readonly items: readonly ImportItem[];
}

/**
 * Attention rows under their stage, in the server's group order. A group the
 * server counted but whose rows are beyond this page still shows its heading
 * and count, so the reader is never told a stage is empty because of paging.
 */
export function importStageSections(
  groups: readonly ImportStageGroup[],
  items: readonly ImportItem[],
): readonly ImportStageSection[] {
  return groups.map((group) => ({
    stage: group.stage,
    count: group.count,
    items: items.filter(
      (item) =>
        item.state.kind === "NeedsAttention" &&
        item.state.stage === group.stage,
    ),
  }));
}

export type ImportHistoryGroupKey =
  | { readonly kind: "Upload"; readonly generation: number }
  | { readonly kind: "Source"; readonly sourceAttemptId: string }
  | { readonly kind: "Index"; readonly revision: number };

export interface ImportHistoryGroup {
  readonly id: string;
  readonly label: string;
  readonly entries: readonly HistoryEntry[];
}

function historyGroupKey(facts: HistoryFacts): ImportHistoryGroupKey {
  if ("generation" in facts) {
    return { kind: "Upload", generation: facts.generation };
  }
  if ("sourceAttemptId" in facts) {
    return { kind: "Source", sourceAttemptId: facts.sourceAttemptId };
  }
  if ("revision" in facts) {
    return { kind: "Index", revision: facts.revision };
  }
  return assertNever(facts, "Unreachable history facts");
}

function historyGroupId(key: ImportHistoryGroupKey): string {
  switch (key.kind) {
    case "Upload":
      return `Upload:${key.generation}`;
    case "Source":
      return `Source:${key.sourceAttemptId}`;
    case "Index":
      return `Index:${key.revision}`;
    default:
      return assertNever(key, "Unreachable history group key");
  }
}

function historyGroupLabel(
  key: ImportHistoryGroupKey,
  entries: readonly HistoryEntry[],
): string {
  switch (key.kind) {
    case "Upload":
      return `Upload attempt ${key.generation}`;
    case "Source": {
      const numbered = entries.find(
        (entry) =>
          entry.facts.kind === "SourceAccepted" ||
          entry.facts.kind === "SourceHistoryBaseline",
      );
      const attemptNo =
        numbered !== undefined &&
        (numbered.facts.kind === "SourceAccepted" ||
          numbered.facts.kind === "SourceHistoryBaseline")
          ? numbered.facts.attemptNo
          : null;
      return attemptNo === null
        ? "Source attempt"
        : `Source attempt ${attemptNo}`;
    }
    case "Index":
      return `Search index revision ${key.revision}`;
    default:
      return assertNever(key, "Unreachable history group key");
  }
}

/**
 * Recorded events as the attempts they belong to, newest attempt first, each
 * attempt keeping the newest-first order the server returned.
 */
export function importHistoryGroups(
  entries: readonly HistoryEntry[],
): readonly ImportHistoryGroup[] {
  const order: string[] = [];
  const byId = new Map<string, { key: ImportHistoryGroupKey; entries: HistoryEntry[] }>();
  for (const entry of entries) {
    const key = historyGroupKey(entry.facts);
    const id = historyGroupId(key);
    const group = byId.get(id);
    if (group === undefined) {
      order.push(id);
      byId.set(id, { key, entries: [entry] });
    } else {
      group.entries.push(entry);
    }
  }
  return order.map((id) => {
    const group = byId.get(id);
    if (group === undefined) {
      // justify-defect: `order` is filled only from `byId` above.
      throw new Error(`History group ${id} was ordered but never collected`);
    }
    return {
      id,
      label: historyGroupLabel(group.key, group.entries),
      entries: group.entries,
    };
  });
}

/**
 * Which recorded time this History query's dates bound. The server correlates
 * the range to the failure event when the query asks about failures, and to any
 * recorded event otherwise (spec, Filters and history).
 */
export function importsDateBounds(state: ImportsUrlState): ImportsDateBounds {
  const failures =
    (state.hadFailures.kind === "Present" && state.hadFailures.value) ||
    state.failureCode.kind === "Present";
  return failures ? "Failure" : "AnyEvent";
}

/** One removable filter, named by the URL field it came from. */
export type ImportsFilterField =
  | "q"
  | "mediaKind"
  | "stage"
  | "failureCode"
  | "currentState"
  | "hadFailures"
  | "from"
  | "before";

export interface ImportsFilterChip {
  readonly id: ImportsFilterField;
  readonly label: string;
}

/**
 * The filters this view actually applies. A History-only filter is kept in the
 * URL while another view is open (the reader wrote it) but is not claimed as
 * applied by a view that cannot correlate it.
 */
export function appliedImportsFilters(
  view: ImportsView,
  state: ImportsUrlState,
  locale: string,
): readonly ImportsFilterChip[] {
  const chips: ImportsFilterChip[] = [];
  if (state.q.kind === "Present") {
    chips.push({ id: "q", label: `Search: ${state.q.value}` });
  }
  if (state.mediaKind.kind === "Present") {
    chips.push({
      id: "mediaKind",
      label: `Type: ${importKindLabel(state.mediaKind.value)}`,
    });
  }
  if (state.stage.kind === "Present") {
    chips.push({
      id: "stage",
      label: `Stage: ${importStageLabel(state.stage.value)}`,
    });
  }
  if (state.failureCode.kind === "Present" && view !== "InProgress") {
    chips.push({
      id: "failureCode",
      label: `Reason: ${IMPORT_FAILURE_COPY[state.failureCode.value].reason}`,
    });
  }
  if (view !== "History") return chips;
  if (state.currentState.kind === "Present") {
    chips.push({
      id: "currentState",
      label: `State: ${IMPORT_STATE_KIND_LABEL[state.currentState.value]}`,
    });
  }
  if (state.hadFailures.kind === "Present") {
    chips.push({
      id: "hadFailures",
      label: state.hadFailures.value
        ? "Had failures"
        : "No recorded failures",
    });
  }
  const dated = importsDateBounds(state);
  if (state.from.kind === "Present") {
    chips.push({
      id: "from",
      label: importsDateChipLabel(dated, "From", state.from.value, locale),
    });
  }
  if (state.before.kind === "Present") {
    chips.push({
      id: "before",
      label: importsDateChipLabel(dated, "Before", state.before.value, locale),
    });
  }
  return chips;
}

/** The same state with one filter removed. Selection and view are not filters. */
export function withoutImportsFilter(
  state: ImportsUrlState,
  field: ImportsFilterField,
): ImportsUrlState {
  return { ...state, [field]: absent() };
}

/** Clear structured constraints without changing committed text or pane identity. */
export function withoutImportsFilters(
  state: ImportsUrlState,
): ImportsUrlState {
  return {
    view: state.view,
    q: state.q,
    mediaKind: absent(),
    stage: absent(),
    failureCode: absent(),
    currentState: absent(),
    hadFailures: absent(),
    from: absent(),
    before: absent(),
    selected: state.selected,
  };
}
