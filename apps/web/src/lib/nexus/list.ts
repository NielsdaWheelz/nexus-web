// The spine: a query's block and passage tail, what is armed and when, and what enter fires. Pure; the
// controller supplies `now`. Ranking is rank.ts's and rows are rows.ts's.
import type { FireTarget, NexusList, NexusRow } from "./model";
import { ARM_WINDOW_MS, DO_CAP, PASSAGE_CAP, PERCEIVED_MS, PLACE_CAP, RESULT_CAP } from "./policy";
import { rowPrimaryText } from "./rowText";
import { compareRank, nameTier } from "./rank";

const TIERS = ["ExplicitIntent", "Latched", "Exact", "PrefixOrToken", "Abbreviation", "Substring", "Lexical", "Semantic"] as const;

export const EMPTY: NexusList = { identity: "", rows: [], first: null, held: [], armed: null, armedAt: 0, deliberate: false, previous: null, paintedAt: 0 };

/**
 * Law 1 at the keystroke: every previous row that still matches `identity` by name, or is the latched
 * row, is held at its tier for the new text; held and the synchronous candidates are ranked once, the
 * latched row first; the best row is armed with latency and the old armed row is remembered while it
 * is still shown. A held row is what the user sees: a synchronous candidate for the same key lends it
 * only its stream, frecency and recency.
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
  const armed = rows[0]?.key ?? null;
  return {
    identity, rows, first: armed, held: rows.map(row => row.key), armed, armedAt: now, deliberate: false,
    previous: previous.armed !== null && rows.some(row => row.key === previous.armed) ? previous.armed : null,
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

/** Shown rows stay put. A latch at capacity replaces the last unarmed resource;
 * passages have their own capacity. Only a named arrival may take the arm. */
export function arrive(list: NexusList, rows: readonly NexusRow[], now: number): NexusList {
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
    const at = block.findLastIndex(old => old.class === "Resource" && old.key !== list.armed);
    if (at >= 0) { block[at] = row; admitted.push(row); }
  }
  const next = [...block, ...[...tail, ...fresh.filter(row => row.class === "Passage")].slice(0, PASSAGE_CAP)];
  const surviving = new Set(next.map(row => row.key));
  const current = { ...list, rows: next, held: list.held.filter(key => surviving.has(key)),
    previous: list.previous !== null && surviving.has(list.previous) ? list.previous : null };
  const named = admitted.filter(row => surviving.has(row.key) && row.rank.tier !== "Lexical" && row.rank.tier !== "Semantic");
  if (list.deliberate || now - list.paintedAt >= ARM_WINDOW_MS || named.length === 0) return current;
  const armed = next.find(row => row.key === list.armed);
  const best = named[0]!;
  if (armed && TIERS.indexOf(best.rank.tier) >= TIERS.indexOf(armed.rank.tier)) return current;
  return { ...current, armed: best.key, armedAt: now, previous: armed ? armed.key : null };
}

/** Drops rows; a dropped armed row arms nothing, a dropped previous is forgotten. */
export function remove(list: NexusList, keys: ReadonlySet<string>): NexusList {
  if (list.rows.every(row => !keys.has(row.key))) return list;
  const rows = list.rows.filter(row => !keys.has(row.key));
  return {
    ...list, rows, held: list.held.filter(key => !keys.has(key)),
    first: list.first !== null && keys.has(list.first) ? null : list.first,
    armed: list.armed !== null && keys.has(list.armed) ? null : list.armed,
    previous: list.previous !== null && keys.has(list.previous) ? null : list.previous,
  };
}

/** Deliberate arming (law 3): fixes the armed row and forgets the previous one. */
export function select(list: NexusList, key: string, now: number): NexusList {
  return { ...list, armed: key, armedAt: now, deliberate: true, previous: null };
}

/**
 * Law 2 for enter: the armed row when deliberate or seen for PERCEIVED_MS; else the remembered previous
 * row; else wait until the later of the two windows while something may still arm; else nothing.
 */
export function fireTarget(list: NexusList, now: number): FireTarget {
  if (list.armed !== null && (list.deliberate || now - list.armedAt >= PERCEIVED_MS)) return { kind: "Fire", key: list.armed };
  if (list.previous !== null) return { kind: "Fire", key: list.previous };
  const until = Math.max(list.armedAt + PERCEIVED_MS, list.paintedAt + ARM_WINDOW_MS);
  if (list.armed !== null || now < list.paintedAt + ARM_WINDOW_MS) return { kind: "Wait", until };
  return { kind: "None" };
}
