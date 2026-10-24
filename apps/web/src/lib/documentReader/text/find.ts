// Find captures its reading anchor and exact scope once. Navigation can change
// independently of the text body; replacement chapters invalidate only a captured
// scope whose identity, interval or extent changed. Painting and geometry survive.
import {
  findInUnits,
  highlightPainter,
  type FindRow,
  type FindSource,
  type TextHit,
} from "@/lib/find/find";
import type { Reader } from "../DocumentReader";
import { clock, transcriptChapterAtPoint, type Structure, type TextDocument, type TextPoint, type TranscriptChapter } from "../model";
import type { TextGeometry } from "./geometry";
import type { Painter } from "./paint";

export interface TextFind {
  readonly source: FindSource<TextHit>;
  update(doc: TextDocument, structure: Structure): FindSource<TextHit>;
}

export function createTextFind(
  initial: TextDocument,
  initialStructure: Structure,
  geometry: TextGeometry,
  painter: Painter,
  reader: Pick<Reader, "inspect" | "getState" | "navigation">,
): TextFind {
  let doc = initial;
  let structure = initialStructure;
  const transcript = doc.format === "transcript";
  const offset = (p: TextPoint) => {
    const range = doc.ranges.findLast((candidate) => candidate.unit === p.unit && candidate.start <= p.offset);
    return range ? range.position + Math.min(p.offset, range.end) - range.start : 0;
  };
  const currentChapter = () => {
    const primary = reader.getState().viewport?.primary;
    return primary?.kind === "text" ? transcriptChapterAtPoint(doc, primary) : null;
  };
  const narrowLabel = () => transcript
    ? currentChapter()?.searchExtent ? "This chapter" : null
    : doc.sections.length > 0 ? "This section" : null;
  let anchor: TextPoint | null = null;
  let chapter: TranscriptChapter | null = null;
  let extent: [number, number] | null = null;
  let scopeInvalidated = false;
  let last: [readonly FindRow<TextHit>[], number] = [[], -1];
  const paint = highlightPainter((hit: TextHit) =>
    painter.near.has(hit.unit) ? geometry.ranges(hit.unit, hit.start, hit.end) : [],
  );
  painter.onNear(() => paint(...last));

  const makeSource = (): FindSource<TextHit> => ({
    key: doc.identity,
    label: transcript ? "find in transcript" : "find in text",
    narrowLabel: narrowLabel(),
    scopeChangeMessage: transcript ? "chapters changed; search cleared" : "sections changed; search cleared",
    scopeInvalidated,
    capturedScopeLabel: chapter?.label ?? null,
    prepare() {
      scopeInvalidated = false;
      const primary = reader.getState().viewport?.primary;
      anchor = primary?.kind === "text" ? primary : null;
      chapter = transcript && anchor ? transcriptChapterAtPoint(doc, anchor) : null;
      if (transcript) {
        const exact = chapter?.searchExtent;
        extent = exact ? [offset(exact.start), offset(exact.end)] : null;
      } else {
        const starts = doc.sections.flatMap((section) => section.at === null ? [] : [offset(section.at)]).sort((a, b) => a - b);
        const at = anchor ? offset(anchor) : -1;
        const start = starts.findLast((s) => s <= at);
        extent = start === undefined ? null : [start, starts.find((s) => s > start) ?? doc.length];
      }
      return extent && anchor ? structure.sectionAt({ kind: "text", ...anchor })?.label ?? null : null;
    },
    search(options, narrow) {
      const scope = narrow ? extent : null;
      if (narrow && scope === null) return { kind: "Failed", message: "Selected scope is unavailable. Clear the search to capture a new scope, or turn off the scope option." };
      const units = doc.ranges.flatMap((range) => {
        const unit = structure.unit(range.unit)!;
        const from = scope === null ? range.start : Math.max(range.start, range.start + scope[0] - range.position);
        const to = scope === null ? range.end : Math.min(range.end, range.start + scope[1] - range.position);
        return to > from ? [{ id: unit.id, text: Array.from(unit.text).slice(from, to).join(""), base: from }] : [];
      });
      return findInUnits(units, options, (hit) => {
        const unit = structure.unit(hit.unit)!;
        const context = [structure.sectionAt({ kind: "text", unit: hit.unit, offset: hit.start })?.label, unit.time && clock(unit.time.startMs), unit.speaker];
        return { at: hit, context: context.filter((part): part is string => Boolean(part)) };
      }, anchor, doc.transcriptCoverage === "partial" ? "available transcript" : null);
    },
    async reveal(hit, signal) {
      const outcome = await reader.inspect({ target: { kind: "range", ...hit }, signal });
      if (outcome.kind === "Cancelled") return { kind: "Cancelled" };
      if (outcome.kind !== "Unavailable") return { kind: "Shown" };
      return { kind: "Failed", message: outcome.reason === "CaptureUnavailable" ? "Reading position is unavailable." : "Find request unavailable. Retry." };
    },
    href(hit) {
      return reader.navigation?.href({ source_identity: doc.identity, target: { kind: "range", ...hit } }) ?? null;
    },
    paint(rows, active) {
      last = [rows, active];
      paint(rows, active);
    },
  });
  let source = makeSource();
  return {
    get source() { return source; },
    update(nextDoc, nextStructure) {
      const changed = doc !== nextDoc;
      const nextChapter = chapter && nextDoc.transcriptNavigation?.chapters.find((candidate) => candidate.id === chapter!.id);
      const invalidated = chapter !== null && (!nextChapter || chapter.startMs !== nextChapter.startMs || chapter.endMs !== nextChapter.endMs || JSON.stringify(chapter.searchExtent) !== JSON.stringify(nextChapter.searchExtent));
      if (invalidated) { chapter = null; extent = null; scopeInvalidated = true; }
      else if (nextChapter) chapter = nextChapter;
      doc = nextDoc;
      structure = nextStructure;
      if (changed || source.narrowLabel !== narrowLabel()) source = makeSource();
      return source;
    },
  };
}
