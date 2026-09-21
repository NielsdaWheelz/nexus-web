import { buildCanonicalCursor } from "./canonicalCursor";
import { resolveDomTextRanges } from "./domTextRanges";
import {
  segmentHighlights,
  type NormalizedHighlight,
  type HighlightColor,
} from "./segmenter";

export type HighlightInput = {
  id: string;
  start_offset: number;
  end_offset: number;
  color: HighlightColor;
  created_at: string;
};

type ApplyHighlightsResult = {
  html: string;
  failedIds: string[];
  validationPassed: boolean;
};

/** Decorate a detached DOM using exact source spans; canonical text is unchanged. */
export function applyHighlightsToHtml(
  htmlSanitized: string,
  canonicalText: string,
  highlights: HighlightInput[],
): ApplyHighlightsResult {
  if (highlights.length === 0) {
    return { html: htmlSanitized, failedIds: [], validationPassed: true };
  }

  const doc = new DOMParser().parseFromString(
    `<div id="__highlight_root__">${htmlSanitized}</div>`,
    "text/html",
  );
  const root = doc.getElementById("__highlight_root__");
  if (!root) {
    return {
      html: htmlSanitized,
      failedIds: highlights.map((highlight) => highlight.id),
      validationPassed: false,
    };
  }
  const cursor = buildCanonicalCursor(root);
  if (cursor.emitted !== canonicalText) {
    return {
      html: htmlSanitized,
      failedIds: highlights.map((highlight) => highlight.id),
      validationPassed: false,
    };
  }

  // NFC can map several canonical codepoints to one raw codepoint. Project
  // before segmenting so that shared source text receives every active id.
  const byNode = new Map<Node, NormalizedHighlight[]>();
  for (const highlight of highlights) {
    const ranges = resolveDomTextRanges(
      cursor,
      highlight.start_offset,
      highlight.end_offset,
    );
    for (const range of ranges ?? []) {
      const projected = {
        id: highlight.id,
        color: highlight.color,
        created_at_ms: Date.parse(highlight.created_at),
        start: range.startOffset,
        end: range.endOffset,
      };
      const existing = byNode.get(range.startContainer);
      if (existing) existing.push(projected);
      else byNode.set(range.startContainer, [projected]);
    }
  }

  const rendered = new Set<string>();
  for (const { node } of cursor.nodes) {
    const projected = byNode.get(node);
    if (!projected) continue;
    const { segments } = segmentHighlights(node.length, projected);
    const firstSpans = new Map<string, HTMLSpanElement>();
    // Split from the end so earlier UTF-16 offsets keep referring to this node.
    for (const segment of segments.reverse()) {
      const target = segment.start > 0 ? node.splitText(segment.start) : node;
      const length = segment.end - segment.start;
      if (length < target.length) target.splitText(length);
      const span = doc.createElement("span");
      span.dataset.activeHighlightIds = segment.activeIds.join(" ");
      span.dataset.highlightTop = segment.topmostId;
      span.className = `hl-${segment.topmostColor}`;
      if (segment.activeIds.some((id) => id.startsWith("evidence-"))) {
        span.classList.add("hl-evidence");
      }
      target.replaceWith(span);
      span.append(target);
      for (const id of segment.activeIds) firstSpans.set(id, span);
    }
    for (const [id, span] of firstSpans) {
      if (rendered.has(id)) continue;
      const anchor = doc.createElement("span");
      anchor.dataset.highlightAnchor = id;
      span.before(anchor);
      rendered.add(id);
    }
  }
  return {
    html: root.innerHTML,
    failedIds: highlights
      .filter((highlight) => !rendered.has(highlight.id))
      .map((highlight) => highlight.id),
    validationPassed: true,
  };
}
