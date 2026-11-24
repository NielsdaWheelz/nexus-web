// Stable row admission and selection within a query. The controller owns submission.
import type { NexusList, NexusRow, NexusSelection } from "./model";
import { ARM_WINDOW_MS, DO_CAP, PASSAGE_CAP, PLACE_CAP, RESULT_CAP } from "./policy";
import { rowPrimaryText } from "./rowText";
import { compareRank, compareTiers, nameTier } from "./rank";

export const EMPTY: NexusList = { identity: "", rows: [], first: null, held: [], selection: { kind: "None" }, paintedAt: 0 };

export function selectedKey(selection: NexusSelection): string | null {
  return "key" in selection ? selection.key : null;
}

/**
 * Retain rows that match the new text by name or latch, then rank once with synchronous
 * candidates. The first row becomes the automatic choice. A synchronous candidate for
 * a held key supplies its stream, frecency and recency.
 */
export function keystroke(previous: NexusList, identity: string, sync: readonly NexusRow[], latchedKey: string | null, now: number): NexusList {
  // Blank context is not a query band: its pane keys have different typed ownership.
  if (previous.identity === "") previous = EMPTY;
  const held = previous.rows.flatMap(row => {
    if (row.class === "Passage" || row.evidence) return [];
    const tier = row.key === latchedKey ? "Latched" : nameTier(identity, rowPrimaryText(row), row.keywords ?? []);
    return tier === null ? [] : [{ ...row, rank: { ...row.rank, tier } }];
  });
  const byKey = new Map(held.map(row => [row.key, row] as const));
  for (const row of sync) {
    const shown = byKey.get(row.key);
    byKey.set(row.key, shown ? { ...shown, rank: { ...row.rank, tier: shown.rank.tier }, frecency: row.frecency, recency: row.recency } : row);
  }
  const rows = arrange([...byKey.values()]);
  const first = rows[0]?.key ?? null;
  return {
    identity, rows, first, held: rows.map(row => row.key),
    selection: first === null ? { kind: "None" } : { kind: "Automatic", key: first },
    paintedAt: now,
  };
}

/** The best row, then commands, places and resources under the class caps. */
function arrange(rows: readonly NexusRow[]): NexusRow[] {
  const [first, ...rest] = [...rows].sort(compareRank);
  if (first === undefined) return [];
  const band = (cls: NexusRow["class"], cap: number) => {
    let taken = 0;
    return rest.filter(row => row.class === cls && (row.rank.tier === "ExplicitIntent" || taken++ < cap));
  };
  return [first, ...band("Do", DO_CAP), ...band("Place", PLACE_CAP), ...rest.filter(row => row.class === "Resource")].slice(0, RESULT_CAP);
}

/** Shown rows stay put. A latch at capacity can replace an unselected resource.
 * Passages have their own cap. Only a named arrival may change an automatic choice. */
export function arrive(list: NexusList, rows: readonly NexusRow[], now: number): NexusList {
  const chosen = selectedKey(list.selection);
  const updates = new Map(rows.map(row => [row.key, row] as const));
  const shown = list.rows.map(row => updates.get(row.key) ?? row);
  const present = new Set(list.rows.map(row => row.key));
  const fresh = rows.filter(row => !present.has(row.key));
  const block = shown.filter(row => row.class !== "Passage");
  const tail = shown.filter(row => row.class === "Passage");
  const cap = list.identity === "" ? Infinity : RESULT_CAP;
  const admitted: NexusRow[] = [];
  for (const row of fresh.filter(row => row.class !== "Passage").sort(compareRank)) {
    if (block.length < cap) { block.push(row); admitted.push(row); continue; }
    if (row.rank.tier !== "Latched") continue;
    const at = block.findLastIndex(old => old.class === "Resource" && old.key !== chosen);
    if (at >= 0) { block[at] = row; admitted.push(row); }
  }
  const next = [...block, ...[...tail, ...fresh.filter(row => row.class === "Passage")].slice(0, PASSAGE_CAP)];
  const surviving = new Set(next.map(row => row.key));
  const current = { ...list, rows: next, held: list.held.filter(key => surviving.has(key)) };
  if (list.identity === "" || list.selection.kind === "Deliberate" || list.selection.kind === "Withdrawn" ||
    now - list.paintedAt >= ARM_WINDOW_MS) return current;
  const best = admitted.find(row => surviving.has(row.key) && row.rank.tier !== "Lexical" && row.rank.tier !== "Semantic");
  if (!best) return current;
  const selected = next.find(row => row.key === chosen);
  if (selected && compareTiers(best.rank.tier, selected.rank.tier) >= 0) return current;
  return { ...current, selection: { kind: "Automatic", key: best.key } };
}

/** Confirmed loss of the chosen row clears it without choosing a replacement. */
export function remove(list: NexusList, keys: ReadonlySet<string>): NexusList {
  if (list.rows.every(row => !keys.has(row.key))) return list;
  const chosen = selectedKey(list.selection);
  return {
    ...list, rows: list.rows.filter(row => !keys.has(row.key)), held: list.held.filter(key => !keys.has(key)),
    first: list.first !== null && keys.has(list.first) ? null : list.first,
    selection: chosen !== null && keys.has(chosen) ? { kind: "Withdrawn" } : list.selection,
  };
}

/** The caller has admitted the displayed choice, including continuations outside the bands. */
export function select(list: NexusList, key: string): NexusList {
  if (list.selection.kind === "Deliberate" && list.selection.key === key) return list;
  return { ...list, selection: { kind: "Deliberate", key } };
}
