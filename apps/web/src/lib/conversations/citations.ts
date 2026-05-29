import type { ReaderCitationData } from "@/components/ui/MarkdownMessage";
import type { ReaderCitationColor } from "@/components/ui/ReaderCitation";
import {
  hrefForReaderTarget,
  readerTargetFromRetrieval,
} from "./readerTarget";
import type {
  CitationIndexEntry,
  ConversationMessage,
  MessageRetrieval,
} from "./types";

const CITATION_COLORS: ReaderCitationColor[] = [
  "yellow",
  "green",
  "blue",
  "pink",
  "purple",
];

function citationColor(n: number): ReaderCitationColor {
  return CITATION_COLORS[(n - 1) % CITATION_COLORS.length] ?? "neutral";
}

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

export function buildCitations(
  message: ConversationMessage,
): ReaderCitationData[] {
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
  const citations: ReaderCitationData[] = [];
  for (const entry of index) {
    const retrieval = byKey.get(`${entry.tool_call_id}:${entry.ordinal}`);
    if (!retrieval) continue;
    const target = readerTargetFromRetrieval(retrieval);
    const href =
      retrieval.deep_link ??
      (retrieval.media_id
        ? hrefForReaderTarget({
            media_id: retrieval.media_id,
            evidence_span_id: retrieval.evidence_span_id,
            locator: retrieval.locator,
          })
        : null);
    citations.push({
      index: entry.n,
      color: citationColor(entry.n),
      preview: {
        title: retrieval.source_title ?? "",
        excerpt: retrieval.exact_snippet ?? "",
        meta: [retrieval.section_label, retrieval.result_type]
          .filter((v): v is string => Boolean(v)),
      },
      target,
      href,
    });
  }
  return citations;
}
