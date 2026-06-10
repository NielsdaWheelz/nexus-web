/**
 * CitationOut render contract. The backend is the sole producer of `CitationOut`
 * (chat ships it on `MessageOut.citations` and the `citation_index` SSE event);
 * this module only maps a server citation to its reader activation target and
 * the `ReaderCitationData` the markdown renderer draws.
 */
import { isRetrievalLocator } from "@/lib/api/sse/locators";
import type { CitationOut } from "./citationOut";
import {
  readerCitationColorForIndex,
  type ReaderCitationData,
} from "./readerCitation";
import { hrefForReaderTarget, type ReaderSourceTarget } from "./readerTarget";

function readerTargetForCitation(c: CitationOut): ReaderSourceTarget | null {
  if (!c.media_id || !isRetrievalLocator(c.locator)) {
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
    href:
      c.deep_link ??
      hrefForReaderTarget({
        media_id: c.media_id,
        evidence_span_id,
        locator: c.locator,
      }),
    evidence_span_id,
  };
}

export function toReaderCitationData(c: CitationOut): ReaderCitationData {
  const evidence_span_id =
    c.target_ref.type === "evidence_span" ? c.target_ref.id : null;
  const summary = c.snapshot?.summary_md?.trim();
  return {
    index: c.ordinal,
    color: readerCitationColorForIndex(c.ordinal),
    preview: {
      title: c.snapshot?.title ?? "",
      excerpt: c.snapshot?.excerpt ?? "",
      ...(summary ? { summary } : {}),
      meta: [c.snapshot?.section_label, c.snapshot?.result_type].filter(
        (v): v is string => Boolean(v),
      ),
    },
    target: readerTargetForCitation(c),
    href:
      c.deep_link ??
      (c.media_id
        ? hrefForReaderTarget({
            media_id: c.media_id,
            evidence_span_id,
            locator: c.locator,
          })
        : null),
  };
}
