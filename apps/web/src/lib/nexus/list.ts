// The spine: a query's two bands, what is armed and when, and what enter fires. Pure; the
// controller supplies `now`. Ranking is rank.ts's and rows are rows.ts's.
import type { FireTarget, NexusList, NexusRow } from "./model";
import { ARM_WINDOW_MS, PERCEIVED_MS } from "./policy";
import { compareRank, nameTier } from "./rank";

const TIERS = ["ExplicitIntent", "Latched", "Exact", "PrefixOrToken", "Abbreviation", "Substring", "Lexical", "Semantic"] as const;

export const EMPTY: NexusList = { identity: "", rows: [], held: 0, armed: null, armedAt: 0, deliberate: false, previous: null, paintedAt: 0 };

/**
 * Law 1 at the keystroke: every previous row that still matches `identity` by name, or is the latched
 * row, is held at its tier for the new text; held and the synchronous candidates are ranked once, the
 * latched row first; the best row is armed with latency and the old armed row is remembered while it
 * is still shown.
 */
export function keystroke(previous: NexusList, identity: string, sync: readonly NexusRow[], latchedKey: string | null, now: number): NexusList {
  const held = previous.rows.flatMap(row => {
    if (row.evidence) return [];
    const tier = row.key === latchedKey ? "Latched" : nameTier(identity, row.label, row.keywords ?? []);
    return tier === null ? [] : [{ ...row, rank: { ...row.rank, tier } }];
  });
  const byKey = new Map(held.map(row => [row.key, row] as const));
  for (const row of sync) byKey.set(row.key, row);
  const rows = [...byKey.values()].sort(compareRank);
  const armed = rows[0]?.key ?? null;
  return {
    identity, rows, held: rows.length, armed, armedAt: now, deliberate: false,
    previous: previous.armed !== null && rows.some(row => row.key === previous.armed) ? previous.armed : null,
    paintedAt: now,
  };
}

/**
 * Rows already shown update in place; new rows append below the held band, ranked among themselves.
 * Within ARM_WINDOW_MS of the paint an arrival whose tier beats the armed row's re-arms it with latency;
 * a deliberate selection is never displaced.
 */
export function arrive(list: NexusList, rows: readonly NexusRow[], now: number): NexusList {
  const updates = new Map(rows.map(row => [row.key, row] as const));
  const shown = list.rows.map(row => updates.get(row.key) ?? row);
  const present = new Set(list.rows.map(row => row.key));
  const fresh = rows.filter(row => !present.has(row.key)).sort(compareRank);
  const next = [...shown, ...fresh];
  if (list.deliberate || now - list.paintedAt >= ARM_WINDOW_MS || fresh.length === 0) return { ...list, rows: next };
  const armed = next.find(row => row.key === list.armed);
  const best = fresh[0]!;
  if (armed && TIERS.indexOf(best.rank.tier) >= TIERS.indexOf(armed.rank.tier)) return { ...list, rows: next };
  return { ...list, rows: next, armed: best.key, armedAt: now, previous: armed ? armed.key : null };
}

/** Drops rows; a dropped armed row arms nothing, a dropped previous is forgotten. */
export function remove(list: NexusList, keys: ReadonlySet<string>): NexusList {
  if (list.rows.every(row => !keys.has(row.key))) return list;
  const rows = list.rows.filter(row => !keys.has(row.key));
  return {
    ...list, rows, held: list.rows.slice(0, list.held).filter(row => !keys.has(row.key)).length,
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
