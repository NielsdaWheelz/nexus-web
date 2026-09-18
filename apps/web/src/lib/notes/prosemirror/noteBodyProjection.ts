import type { Node as ProseMirrorNode } from "prosemirror-model";
import { codepointLength } from "@/lib/highlights/codepoints";

// Python str.strip/rstrip includes these controls and excludes U+FEFF.
const PYTHON_WHITESPACE = /[\p{White_Space}\u001c-\u001f]/u;
const TRAILING_PYTHON_WHITESPACE = /[\p{White_Space}\u001c-\u001f]+$/u;
const PYTHON_LINE_BREAK = /(\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029])/u;

interface NoteBodyProjectionSpan {
  startOffset: number;
  endOffset: number;
  from: number;
  to: number;
  kind: "inline" | "node";
  exactText: string | null;
}

interface SourceSpan {
  text: string;
  start: number;
  end: number;
  from: number;
  to: number;
  kind: "inline" | "node";
}

/**
 * Project one valid note body into persisted text and editor positions.
 * Positions use the body's coordinates as the sole top-level note_body_doc node.
 */
export function projectNoteBody(body: ProseMirrorNode): {
  text: string;
  spans: NoteBodyProjectionSpan[];
} {
  const sources: SourceSpan[] = [];
  let rawLength = 0;
  const appendSource = (node: ProseMirrorNode, from: number, text: string) => {
    if (!text) return;
    sources.push({
      text,
      start: rawLength,
      end: rawLength + text.length,
      from,
      to: from + node.nodeSize,
      kind: node.isText ? "inline" : "node",
    });
    rawLength += text.length;
  };
  const appendNode = (node: ProseMirrorNode, position: number) => {
    switch (node.type.name) {
      case "text":
        appendSource(node, position, node.textContent);
        break;
      case "hard_break":
        appendSource(node, position, "\n");
        break;
      case "object_ref":
      case "object_embed":
        appendSource(
          node,
          position,
          node.attrs.label || `${node.attrs.objectType}:${node.attrs.objectId}`,
        );
        break;
      case "image":
        appendSource(node, position, node.attrs.alt ?? "");
    }
  };

  if (body.type.name === "object_embed") {
    appendNode(body, 0);
  } else {
    body.descendants((node, position) => appendNode(node, position + 1));
  }

  const raw = sources.map((source) => source.text).join("");
  // Final strip commutes with per-line rstrip; trimming once retains source positions.
  let rawStart = 0;
  let rawEnd = raw.length;
  while (rawStart < rawEnd && PYTHON_WHITESPACE.test(raw[rawStart]!)) rawStart++;
  while (rawEnd > rawStart && PYTHON_WHITESPACE.test(raw[rawEnd - 1]!)) rawEnd--;

  let text = "";
  let projectedOffset = 0;
  const spans: NoteBodyProjectionSpan[] = [];
  const appendProjected = (
    sourceStart: number,
    sourceEnd: number,
    projectedText: string,
    exact: boolean,
  ) => {
    const startOffset = projectedOffset;
    const endOffset = startOffset + codepointLength(projectedText);
    let consumedOffset = startOffset;
    for (const source of sources) {
      const intersectionStart = Math.max(sourceStart, source.start);
      const intersectionEnd = Math.min(sourceEnd, source.end);
      if (intersectionStart >= intersectionEnd) continue;
      const intersectionText = raw.slice(intersectionStart, intersectionEnd);
      const intersectionLength = codepointLength(intersectionText);
      spans.push({
        startOffset: exact ? consumedOffset : startOffset,
        endOffset: exact ? consumedOffset + intersectionLength : endOffset,
        from: source.kind === "inline"
          ? source.from + intersectionStart - source.start
          : source.from,
        to: source.kind === "inline"
          ? source.from + intersectionEnd - source.start
          : source.to,
        kind: source.kind,
        exactText:
          exact && source.kind === "inline" ? intersectionText : null,
      });
      consumedOffset += intersectionLength;
    }
    text += projectedText;
    projectedOffset = endOffset;
  };

  let sourceStart = rawStart;
  const parts = raw.slice(rawStart, rawEnd).split(PYTHON_LINE_BREAK);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const isBreak = index % 2 === 1;
    const projectedText = isBreak
      ? "\n"
      : part.replace(TRAILING_PYTHON_WHITESPACE, "");
    if (projectedText) {
      const sourceEnd = sourceStart + (isBreak ? part.length : projectedText.length);
      appendProjected(
        sourceStart,
        sourceEnd,
        projectedText,
        projectedText === raw.slice(sourceStart, sourceEnd),
      );
    }
    sourceStart += part.length;
  }
  return { text, spans };
}
