import type { EmphasisSegment } from "@/lib/ui/emphasis";

const MATCH_THRESHOLD = 2_000;
const SNIPPET_CONTEXT_CODEPOINTS = 64;

export interface CanonicalTextFindUnit {
  readonly id: string;
  readonly text: string;
}

export interface CanonicalTextFindOccurrence {
  readonly unitId: string;
  readonly startCp: number;
  readonly endCp: number;
  readonly snippet: readonly EmphasisSegment[];
}

export type CanonicalTextFindResult =
  | {
      readonly kind: "Ready";
      readonly completeness: "Complete" | "Partial";
      readonly occurrences: readonly CanonicalTextFindOccurrence[];
    }
  | {
      readonly kind: "NoMatches";
      readonly completeness: "Complete" | "Partial";
    }
  | { readonly kind: "TooManyMatches"; readonly threshold: 2_000 };

interface RawMatch {
  readonly unitIndex: number;
  readonly startUtf16: number;
  readonly endUtf16: number;
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordBoundaries(
  segmenter: Intl.Segmenter,
  text: string,
): ReadonlySet<number> {
  const boundaries = new Set<number>([0, text.length]);
  for (const segment of segmenter.segment(text)) {
    boundaries.add(segment.index);
  }
  return boundaries;
}

function nextCodePointIndex(text: string, utf16Index: number): number {
  const codePoint = text.codePointAt(utf16Index);
  if (codePoint === undefined) {
    throw new Error("Pane Find match offset must be inside its logical unit.");
  }
  return utf16Index + (codePoint > 0xffff ? 2 : 1);
}

function snippetSegments(
  codePoints: readonly string[],
  startCp: number,
  endCp: number,
): readonly EmphasisSegment[] {
  const snippetStartCp = Math.max(0, startCp - SNIPPET_CONTEXT_CODEPOINTS);
  const snippetEndCp = Math.min(
    codePoints.length,
    endCp + SNIPPET_CONTEXT_CODEPOINTS,
  );
  const segments: EmphasisSegment[] = [
    {
      text: codePoints.slice(snippetStartCp, startCp).join(""),
      emphasized: false,
    },
    {
      text: codePoints.slice(startCp, endCp).join(""),
      emphasized: true,
    },
    {
      text: codePoints.slice(endCp, snippetEndCp).join(""),
      emphasized: false,
    },
  ];
  return segments.filter(({ text }) => text.length > 0);
}

function projectUnitMatches(
  unit: CanonicalTextFindUnit,
  matches: readonly RawMatch[],
): readonly CanonicalTextFindOccurrence[] {
  const codePoints: string[] = [];
  const codepointIndexByUtf16 = new Map<number, number>([[0, 0]]);
  let utf16Index = 0;
  for (const codePoint of unit.text) {
    codePoints.push(codePoint);
    utf16Index += codePoint.length;
    codepointIndexByUtf16.set(utf16Index, codePoints.length);
  }

  return matches.map(({ startUtf16, endUtf16 }) => {
    const startCp = codepointIndexByUtf16.get(startUtf16);
    const endCp = codepointIndexByUtf16.get(endUtf16);
    if (startCp === undefined || endCp === undefined) {
      throw new Error(
        "Pane Find regex offsets must align to Unicode codepoint boundaries.",
      );
    }
    return {
      unitId: unit.id,
      startCp,
      endCp,
      snippet: snippetSegments(codePoints, startCp, endCp),
    };
  });
}

export function canonicalTextFind({
  units,
  query,
  matchCase,
  wholeWord,
  completeness,
}: {
  readonly units: readonly CanonicalTextFindUnit[];
  readonly query: string;
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
  readonly completeness: "Complete" | "Partial";
}): CanonicalTextFindResult {
  const normalizedQuery = query.normalize("NFC");
  if (normalizedQuery.length === 0) {
    throw new Error("Canonical text Find requires a non-empty literal query.");
  }

  const expression = new RegExp(
    escapeRegExpLiteral(normalizedQuery),
    matchCase ? "gu" : "giu",
  );
  const segmenter = wholeWord
    ? new Intl.Segmenter("und", { granularity: "word" })
    : null;
  const rawMatches: RawMatch[] = [];

  for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
    const unit = units[unitIndex]!;
    const boundaries = segmenter
      ? wordBoundaries(segmenter, unit.text)
      : null;
    expression.lastIndex = 0;

    let match = expression.exec(unit.text);
    while (match !== null) {
      const startUtf16 = match.index;
      const endUtf16 = startUtf16 + match[0].length;
      if (
        boundaries === null ||
        (boundaries.has(startUtf16) && boundaries.has(endUtf16))
      ) {
        rawMatches.push({ unitIndex, startUtf16, endUtf16 });
        if (rawMatches.length > MATCH_THRESHOLD) {
          return { kind: "TooManyMatches", threshold: MATCH_THRESHOLD };
        }
      } else {
        expression.lastIndex = nextCodePointIndex(unit.text, startUtf16);
      }
      match = expression.exec(unit.text);
    }
  }

  if (rawMatches.length === 0) {
    return { kind: "NoMatches", completeness };
  }

  const occurrences: CanonicalTextFindOccurrence[] = [];
  let matchIndex = 0;
  for (
    let unitIndex = 0;
    unitIndex < units.length && matchIndex < rawMatches.length;
    unitIndex += 1
  ) {
    const unitMatches: RawMatch[] = [];
    while (rawMatches[matchIndex]?.unitIndex === unitIndex) {
      unitMatches.push(rawMatches[matchIndex]!);
      matchIndex += 1;
    }
    if (unitMatches.length > 0) {
      occurrences.push(...projectUnitMatches(units[unitIndex]!, unitMatches));
    }
  }

  return { kind: "Ready", completeness, occurrences };
}
