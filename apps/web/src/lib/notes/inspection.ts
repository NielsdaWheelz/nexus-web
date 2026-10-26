import type { Node as PMNode } from "prosemirror-model";
import { Decoration, DecorationSet } from "prosemirror-view";
import { projectBody } from "@nexus/authored/body";
import { codepointToUtf16 } from "@/lib/canonicalText/codepoints";
/** Decorations over stored-text codepoint offsets (a passage anchor or a citation). */
export function inspectionDecorations(
  doc: PMNode,
  target: { startOffset: number; endOffset: number },
): DecorationSet {
  const start = Math.max(0, Math.floor(target.startOffset));
  const end = Math.max(start, Math.floor(target.endOffset));
  const offset = doc.type.name === "outline_doc" ? 1 : 0;
  const block = offset === 1 ? doc.firstChild?.firstChild : doc.firstChild;
  if (!block || end <= start) return DecorationSet.empty;
  const attrs = {
    class: "nexus-note-inspection",
    "data-note-inspection-range": "true",
  };
  const decorations: Decoration[] = [];
  for (const span of projectBody(block).spans) {
    if (span.end <= start || span.start >= end) continue;
    const from = offset + (
      span.exact === null
        ? span.from
        : span.from + codepointToUtf16(span.exact, Math.max(0, start - span.start)));
    const to = offset + (
      span.exact === null
        ? span.to
        : span.from + codepointToUtf16(span.exact, Math.min(end, span.end) - span.start));
    const previous = decorations.at(-1);
    if (previous?.from === from && previous.to === to) continue;
    decorations.push(
      span.inline
        ? Decoration.inline(from, to, attrs)
        : Decoration.node(from, to, attrs),
    );
  }
  return DecorationSet.create(doc, decorations);
}
