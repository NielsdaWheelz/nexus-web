/**
 * The ONE frontend citation adapter (spec §12, G6). The backend is now the
 * sole `CitationOut` producer (built from edges, per the generation-run-harness
 * render contract); this module owns the single remaining transform —
 * `CitationOut` → `ReaderCitationData`, the shape `ReaderCitation` renders.
 * Chat, Oracle, Library Intelligence, attached resources, and read-resource
 * evidence all flow through here. The renderer's input type is unchanged.
 */

import { isRetrievalLocator } from "@/lib/api/sse/locators";
import type { CitationOut } from "@/lib/conversations/citationOut";
import { hrefForResourceActivation } from "@/lib/resources/activation";
import {
  readerCitationColorForIndex,
  type ReaderCitationData,
} from "@/lib/conversations/readerCitation";
import { type ReaderSourceTarget } from "@/lib/conversations/readerTarget";

function readerTargetForCitation(c: CitationOut): ReaderSourceTarget | null {
  if (!isRetrievalLocator(c.locator)) {
    return null;
  }
  if (c.locator.type === "note_block_offsets") {
    return {
      kind: "note",
      source: "message_retrieval",
      block_id: c.locator.block_id,
      start_offset: c.locator.start_offset,
      end_offset: c.locator.end_offset,
      snippet: c.snapshot?.excerpt ?? null,
      highlight_behavior: "pulse",
      focus_behavior: "scroll_into_view",
      label: c.snapshot?.title ?? undefined,
      href: hrefForResourceActivation(c.activation),
      evidence_id: c.target_ref.id,
    };
  }
  if (!c.media_id) {
    return null;
  }
  const evidence_span_id =
    c.target_ref.type === "evidence_span" ? c.target_ref.id : null;
  return {
    kind: "media",
    source: "message_retrieval",
    media_id: c.media_id,
    locator: c.locator,
    snippet: c.snapshot?.excerpt ?? null,
    highlight_behavior: "pulse",
    focus_behavior: "scroll_into_view",
    label: c.snapshot?.title ?? undefined,
    href: hrefForResourceActivation(c.activation),
    evidence_span_id,
  };
}

export function toReaderCitationData(c: CitationOut): ReaderCitationData {
  const target = readerTargetForCitation(c);
  return {
    index: c.ordinal,
    color: readerCitationColorForIndex(c.ordinal),
    preview: {
      title: c.snapshot?.title ?? "",
      excerpt: c.snapshot?.excerpt ?? "",
      meta: [c.snapshot?.section_label, c.snapshot?.result_type].filter(
        (v): v is string => Boolean(v),
      ),
    },
    activation: c.activation,
    target,
  };
}
