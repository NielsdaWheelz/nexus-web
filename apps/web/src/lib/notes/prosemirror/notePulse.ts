import type { Node as ProseMirrorNode } from "prosemirror-model";
import { Decoration, DecorationSet } from "prosemirror-view";
import { codepointLength, codepointToUtf16 } from "@/lib/highlights/codepoints";

// Python str.strip/rstrip includes these controls and excludes U+FEFF.
const WHITESPACE = /[\p{White_Space}\u001c-\u001f]/u;
const TRAILING_WHITESPACE = /[\p{White_Space}\u001c-\u001f]+$/u;
const LINE_BREAK = /(\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029])/u;

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

  const nodes: {
    node: ProseMirrorNode;
    position: number;
    text: string;
    start: number;
    end: number;
  }[] = [];
  let rawLength = 0;
  doc.descendants((node, position) => {
    let text: string;
    switch (node.type.name) {
      case "text":
        text = node.textContent;
        break;
      case "hard_break":
        text = "\n";
        break;
      case "object_ref":
      case "object_embed":
        text = node.attrs.label || `${node.attrs.objectType}:${node.attrs.objectId}`;
        break;
      case "image":
        text = node.attrs.alt ?? "";
        break;
      default:
        return;
    }
    nodes.push({
      node, position, text, start: rawLength, end: rawLength + text.length,
    });
    rawLength += text.length;
  });
  const raw = nodes.map((node) => node.text).join("");
  // Outer trimming commutes with line trimming; do it first to retain raw offsets.
  let rawStart = 0;
  let rawEnd = raw.length;
  while (rawStart < rawEnd && WHITESPACE.test(raw[rawStart])) rawStart++;
  while (rawEnd > rawStart && WHITESPACE.test(raw[rawEnd - 1])) rawEnd--;

  const decorations: Decoration[] = [];
  let projectedOffset = 0;
  let nodeIndex = 0;
  const parts = raw.slice(rawStart, rawEnd).split(LINE_BREAK);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const isBreak = index % 2 === 1;
    const text = isBreak ? "\n" : part.replace(TRAILING_WHITESPACE, "");
    const nextOffset = projectedOffset + codepointLength(text);
    if (nextOffset > start && projectedOffset < end) {
      const from = rawStart + (isBreak
        ? 0
        : codepointToUtf16(text, Math.max(0, start - projectedOffset)));
      const to = rawStart + (isBreak
        ? part.length
        : codepointToUtf16(text, Math.min(end, nextOffset) - projectedOffset));
      while (nodeIndex < nodes.length && nodes[nodeIndex].end <= from) nodeIndex++;
      for (
        let cursor = nodeIndex;
        cursor < nodes.length && nodes[cursor].start < to;
        cursor++
      ) {
        const source = nodes[cursor];
        if (source.end <= from) continue;
        const decorationFrom = source.position + (source.node.isText
          ? Math.max(0, from - source.start)
          : 0);
        const decorationTo = source.node.isText
          ? source.position + Math.min(source.text.length, to - source.start)
          : source.position + source.node.nodeSize;
        const previous = decorations.at(-1);
        if (previous?.from === decorationFrom && previous.to === decorationTo) continue;
        const attrs = {
          class: "nexus-note-range-pulse", "data-note-pulse-range": "true",
        };
        decorations.push(
          source.node.isText
            ? Decoration.inline(decorationFrom, decorationTo, attrs)
            : Decoration.node(decorationFrom, decorationTo, attrs),
        );
      }
    }
    projectedOffset = nextOffset;
    rawStart += part.length;
    if (projectedOffset >= end) break;
  }
  return DecorationSet.create(doc, decorations);
}
