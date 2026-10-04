import type { EmphasisSegment } from "@/lib/ui/emphasis";

/** More matches than this is a refusal, not a result; pdf.js obeys it too. */
export const FIND_LIMIT = 2_000;
const CONTEXT_CODEPOINTS = 64;

export interface FindOptions {
  readonly query: string;
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
}

/** One searchable string. Matches never cross units; `base` re-offsets a sliced unit. */
export interface FindUnit {
  readonly id: string;
  readonly text: string;
  readonly base?: number;
}

/** A match: a right-open codepoint range of its unit. */
export interface TextHit {
  readonly unit: string;
  readonly start: number;
  readonly end: number;
}

/** `at` is the surface's own locator; nothing but the surface reads it. */
export interface FindRow<L> {
  readonly at: L;
  readonly context: readonly string[];
  readonly snippet: readonly EmphasisSegment[];
}

export type FindOutcome<L> =
  | {
      readonly kind: "Rows";
      readonly rows: readonly FindRow<L>[];
      readonly initial: number;
      readonly partial: string | null;
    }
  | { readonly kind: "TooMany" }
  | { readonly kind: "Failed"; readonly message: string };

/**
 * Everything a surface supplies; useFind owns query state, debounce, staleness,
 * stepping and results.
 * - key names the searched snapshot: a new key re-prepares and re-runs the live query.
 * - prepare runs when find opens. It freezes the reading anchor and the narrow
 *   scope, and returns the narrow scope's label or null.
 * - search returns rows in document order; `initial` is the first at or after the anchor.
 * - reveal resolves to null once the row is shown, or to the refusal text.
 * - paint is declarative: the rows and active index after every change; ([], -1) clears.
 * - returnToOrigin exists only where find owns the way back (no reader owns movement).
 * Methods, not function properties: parameter bivariance lets any FindSource<L>
 * stand where FindSource<unknown> is expected.
 */
export interface FindSource<L> {
  readonly key: string;
  readonly label: string;
  prepare(): string | null;
  search(
    options: FindOptions,
    narrow: boolean,
    signal: AbortSignal,
  ): Promise<FindOutcome<L>> | FindOutcome<L>;
  reveal(at: L, signal: AbortSignal): Promise<string | null>;
  paint(rows: readonly FindRow<L>[], active: number): void;
  returnToOrigin?(): void;
}

/** ±64 codepoints around a UTF-16 range; a 128-unit window always holds 64 whole codepoints. */
export function snippet(
  text: string,
  start: number,
  end: number,
): readonly EmphasisSegment[] {
  const before = Array.from(
    text.slice(Math.max(0, start - 2 * CONTEXT_CODEPOINTS), start),
  ).slice(-CONTEXT_CODEPOINTS);
  const after = Array.from(text.slice(end, end + 2 * CONTEXT_CODEPOINTS)).slice(
    0,
    CONTEXT_CODEPOINTS,
  );
  return [
    { text: before.join(""), emphasized: false },
    { text: text.slice(start, end), emphasized: true },
    { text: after.join(""), emphasized: false },
  ].filter((segment) => segment.text.length > 0);
}

/**
 * The one matcher: an NFC literal, simple case folding unless matchCase, UAX#29
 * word boundaries when wholeWord, leftmost non-overlapping, in unit order.
 * Diacritics always count.
 */
export function findInUnits<L>(
  units: readonly FindUnit[],
  options: FindOptions,
  locate: (hit: TextHit) => {
    readonly at: L;
    readonly context: readonly string[];
  },
  anchor: { readonly unit: string; readonly offset: number } | null = null,
  partial: string | null = null,
): FindOutcome<L> {
  const literal = options.query
    .normalize("NFC")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(literal, options.matchCase ? "gu" : "giu");
  const words = options.wholeWord
    ? new Intl.Segmenter("und", { granularity: "word" })
    : null;
  const anchorUnit = anchor
    ? units.findIndex((unit) => unit.id === anchor.unit)
    : -1;
  const rows: FindRow<L>[] = [];
  let initial = -1;
  for (const [unitIndex, { id, text, base = 0 }] of units.entries()) {
    let bounds: Set<number> | null = null;
    let codepoints = base;
    let scanned = 0;
    const toCodepoint = (utf16: number) => {
      for (; scanned < utf16; scanned += 1)
        if ((text.charCodeAt(scanned) & 0xfc00) !== 0xdc00) codepoints += 1;
      return codepoints;
    };
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const start = match.index;
      const end = start + match[0].length;
      if (words) {
        bounds ??= new Set([
          text.length,
          ...Array.from(words.segment(text), (segment) => segment.index),
        ]);
        if (!bounds.has(start) || !bounds.has(end)) {
          // A rejected candidate may hide an overlapping word match one codepoint on.
          pattern.lastIndex =
            start + (text.codePointAt(start)! > 0xffff ? 2 : 1);
          continue;
        }
      }
      const hit = {
        unit: id,
        start: toCodepoint(start),
        end: toCodepoint(end),
      };
      if (
        initial < 0 &&
        (unitIndex > anchorUnit ||
          (unitIndex === anchorUnit && hit.start >= anchor!.offset))
      )
        initial = rows.length;
      rows.push({ ...locate(hit), snippet: snippet(text, start, end) });
      if (rows.length > FIND_LIMIT) return { kind: "TooMany" };
    }
  }
  return { kind: "Rows", rows, initial: Math.max(initial, 0), partial };
}

const shares = new Map<
  symbol,
  { readonly all: readonly Range[]; readonly active: readonly Range[] }
>();

/**
 * A FindSource.paint over the document-wide `nexus-find-all` / `nexus-find-active`
 * custom highlights. Every pane paints into the same two highlights, so each
 * painter owns one share and publishes the union.
 */
export function highlightPainter<L>(
  ranges: (at: L) => readonly Range[],
): FindSource<L>["paint"] {
  const owner = Symbol("find");
  return (rows, active) => {
    const all = rows.flatMap((row) => ranges(row.at));
    if (all.length > 0)
      shares.set(owner, {
        all,
        active: active < 0 ? [] : ranges(rows[active]!.at),
      });
    else if (!shares.delete(owner)) return;
    for (const [name, priority] of [
      ["nexus-find-all", 0],
      ["nexus-find-active", 1],
    ] as const) {
      const union = [...shares.values()].flatMap((share) =>
        priority ? share.active : share.all,
      );
      if (union.length === 0) CSS.highlights.delete(name);
      else
        CSS.highlights.set(
          name,
          Object.assign(new Highlight(...union), { priority }),
        );
    }
  };
}
