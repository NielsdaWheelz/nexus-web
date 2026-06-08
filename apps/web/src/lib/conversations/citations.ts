import { isRetrievalLocator } from "@/lib/api/sse/locators";
import type {
  CitationOut,
  CitationTargetRef,
} from "./citationOut";
import {
  readerCitationColorForIndex,
  type ReaderCitationData,
} from "./readerCitation";
import { hrefForReaderTarget, type ReaderSourceTarget } from "./readerTarget";
import type {
  CitationIndexEntry,
  ConversationMessage,
  MessageRetrieval,
} from "./types";

function retrievalBlocksOf(message: ConversationMessage): MessageRetrieval[] {
  const blocks = message.message_document?.blocks ?? [];
  const out: MessageRetrieval[] = [];
  for (const block of blocks) {
    if (block.type !== "retrieval_result") continue;
    const { type: _type, ...rest } = block;
    out.push(rest);
  }
  return out;
}

function citationIndexFromBlocks(retrievals: MessageRetrieval[]): CitationIndexEntry[] {
  const entries: CitationIndexEntry[] = [];
  for (const r of retrievals) {
    if (
      r.citation_ordinal != null &&
      r.tool_call_id != null &&
      r.ordinal != null
    ) {
      entries.push({
        n: r.citation_ordinal,
        retrieval_id: r.id ?? "",
        tool_call_id: r.tool_call_id,
        ordinal: r.ordinal,
      });
    }
  }
  return entries;
}

function targetRefFromRetrieval(retrieval: MessageRetrieval): CitationTargetRef {
  if (retrieval.evidence_span_id) {
    return { type: "evidence_span", id: retrieval.evidence_span_id };
  }
  if (retrieval.result_type === "content_chunk") {
    return { type: "content_chunk", id: retrieval.source_id };
  }
  return { type: "media", id: retrieval.media_id ?? retrieval.source_id };
}

export function messageToCitationOuts(
  message: ConversationMessage,
): CitationOut[] {
  const retrievals = message.retrievals?.length
    ? message.retrievals
    : retrievalBlocksOf(message);
  const index = message.citation_index?.length
    ? message.citation_index
    : citationIndexFromBlocks(retrievals);
  if (!index.length) return [];
  const byKey = new Map<string, MessageRetrieval>();
  for (const retrieval of retrievals) {
    if (retrieval.tool_call_id != null && retrieval.ordinal != null) {
      byKey.set(`${retrieval.tool_call_id}:${retrieval.ordinal}`, retrieval);
    }
  }
  const citations: CitationOut[] = [];
  for (const entry of index) {
    const retrieval = byKey.get(`${entry.tool_call_id}:${entry.ordinal}`);
    if (!retrieval) continue;
    citations.push({
      ordinal: entry.n,
      role: "context",
      target_ref: targetRefFromRetrieval(retrieval),
      media_id: retrieval.media_id,
      locator: retrieval.locator ?? null,
      deep_link: retrieval.deep_link,
      snapshot: {
        title: retrieval.source_title,
        excerpt: retrieval.exact_snippet,
        section_label: retrieval.section_label,
        summary_md: retrieval.summary_md,
        result_type: retrieval.result_type,
      },
    });
  }
  return citations;
}

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
