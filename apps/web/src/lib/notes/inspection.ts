import type { Node as PMNode } from "prosemirror-model";
import { Decoration, DecorationSet } from "prosemirror-view";
import {normalizeQuote} from "@nexus/authored/identity";
import { projectBody } from "@nexus/authored/body";
import { codepointToUtf16 } from "@/lib/canonicalText/codepoints";
/** Decorations over stored-text codepoint offsets (a passage anchor or a citation). */
export function inspectionDecorations(
  doc: PMNode,
  target: { text: string; startOffset: number; endOffset: number },
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
  const projection = projectBody(block);
  if (projection.text !== target.text) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  for (const span of projection.spans) {
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

/** Same projection as text_quote.project_note_match: equal NFD components retain
 * occurrence order through NFC. Refuse a hit that cannot name one exact interval. */
export function bodyPassageRange(text: string, start: number, end: number, exact: string): { startOffset: number; endOffset: number } | null {
  const nfc = text.normalize("NFC");
  if (nfc === text) return normalizeQuote(Array.from(text).slice(start, end).join("")) === exact ? { startOffset: start, endOffset: end } : null;
  const count = (value: string) => {
    const counts = new Map<string, number>();
    for (const component of value.normalize("NFD")) counts.set(component, (counts.get(component) ?? 0) + 1);
    return counts;
  };
  const normalized = Array.from(nfc), raw = Array.from(text);
  const remaining = count(normalized.slice(start, end).join(""));
  const preceding = count(normalized.slice(0, start).join(""));
  let from = raw.length, to = 0;
  for (const [index, char] of raw.entries()) {
    for (const component of char.normalize("NFD")) {
      if (!remaining.has(component)) continue;
      const before = preceding.get(component) ?? 0;
      if (before > 0) preceding.set(component, before - 1);
      else if ((remaining.get(component) ?? 0) > 0) {
        remaining.set(component, remaining.get(component)! - 1);
        from = Math.min(from, index); to = index + 1;
      }
    }
  }
  return normalizeQuote(raw.slice(from, to).join("")) === exact ? { startOffset: from, endOffset: to } : null;
}
