// Find over a text publication: every unit is searched (all are mounted);
// the narrow scope is the section (a transcript's chapter) at the reading
// position when find opens. A reveal is a reader jump, so the reader holds the
// way back. Paint registers static ranges for units in the paint window only,
// and repaints as units enter it.
import {
  findInUnits,
  highlightPainter,
  type FindRow,
  type FindSource,
  type TextHit,
} from "@/lib/find/find";
import type { Reader } from "../DocumentReader";
import { clock, type Structure, type TextDocument, type TextPoint } from "../model";
import type { TextGeometry } from "./geometry";
import type { Painter } from "./paint";

export function createTextFind(
  doc: TextDocument,
  structure: Structure,
  geometry: TextGeometry,
  painter: Painter,
  reader: Pick<Reader, "inspect" | "getState">,
): FindSource<TextHit> {
  const transcript = doc.format === "transcript";
  const offset = (p: TextPoint) =>
    (structure.unit(p.unit)?.start ?? 0) + p.offset;
  const starts = doc.sections.map((s) => offset(s.at)).sort((a, b) => a - b);
  let anchor: TextPoint | null = null;
  let extent: [number, number] | null = null;
  let last: [readonly FindRow<TextHit>[], number] = [[], -1];
  const paint = highlightPainter((hit: TextHit) =>
    painter.near.has(hit.unit)
      ? geometry.ranges(hit.unit, hit.start, hit.end)
      : [],
  );
  painter.onNear(() => paint(...last));

  return {
    key: doc.identity,
    label: transcript
      ? "Find in transcript"
      : doc.format === "epub"
        ? "Find in book"
        : "Find in article",
    prepare() {
      const primary = reader.getState().viewport?.primary;
      anchor = primary?.kind === "text" ? primary : null;
      const at = anchor ? offset(anchor) : -1;
      const start = starts.findLast((s) => s <= at);
      extent =
        start === undefined
          ? null
          : [start, starts.find((s) => s > start) ?? doc.length];
      return extent && (transcript ? "This chapter" : "This section");
    },
    search(options, narrow) {
      const units = doc.units.flatMap((unit) => {
        if (!narrow || !extent) return [{ id: unit.id, text: unit.text }];
        const from = Math.max(0, extent[0] - unit.start);
        const to = Math.min(unit.length, extent[1] - unit.start);
        const text = Array.from(unit.text).slice(from, to).join("");
        return to > from ? [{ id: unit.id, text, base: from }] : [];
      });
      return findInUnits(
        units,
        options,
        (hit) => {
          const unit = structure.unit(hit.unit)!;
          const point = { kind: "text" as const, ...hit, offset: hit.start };
          const context = [
            structure.sectionAt(point)?.label,
            unit.time && clock(unit.time.startMs),
            unit.speaker,
          ];
          return {
            at: hit,
            context: context.filter((part): part is string => Boolean(part)),
          };
        },
        anchor,
      );
    },
    async reveal(hit) {
      const outcome = await reader.inspect({ kind: "range", ...hit });
      if (outcome.kind !== "Unavailable") return null;
      return outcome.reason === "CaptureUnavailable"
        ? "Reading position is unavailable."
        : "Find request unavailable. Retry.";
    },
    paint(rows, active) {
      last = [rows, active];
      paint(rows, active);
    },
  };
}
