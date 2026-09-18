import type { Node as ProseMirrorNode } from "prosemirror-model";
import { Decoration, DecorationSet } from "prosemirror-view";
import { codepointToUtf16 } from "@/lib/highlights/codepoints";
import { projectNoteBody } from "@/lib/notes/prosemirror/noteBodyProjection";

/** Map stored note-body codepoints to editor positions without changing the note.
 * Mirrors python/nexus/services/note_bodies.py:text_from_pm_json: leaf text,
 * splitlines, per-line rstrip, then document strip. Unicode is not normalized.
 */
export function notePulseDecorations(
  doc: ProseMirrorNode,
  target: { startOffset: number; endOffset: number },
): DecorationSet {
  const start = Math.max(0, Math.floor(target.startOffset));
  const end = Math.max(start, Math.floor(target.endOffset));
  if (end <= start) return DecorationSet.empty;

  const body = doc.firstChild;
  if (!body) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  for (const span of projectNoteBody(body).spans) {
    if (span.endOffset <= start || span.startOffset >= end) continue;
    const from = span.exactText === null
      ? span.from
      : span.from + codepointToUtf16(
          span.exactText,
          Math.max(0, start - span.startOffset),
        );
    const to = span.exactText === null
      ? span.to
      : span.from + codepointToUtf16(
          span.exactText,
          Math.min(end, span.endOffset) - span.startOffset,
        );
    const previous = decorations.at(-1);
    if (previous?.from === from && previous.to === to) continue;
    const attrs = {
      class: "nexus-note-range-pulse", "data-note-pulse-range": "true",
    };
    decorations.push(
      span.kind === "inline"
        ? Decoration.inline(from, to, attrs)
        : Decoration.node(from, to, attrs),
    );
  }
  return DecorationSet.create(doc, decorations);
}
