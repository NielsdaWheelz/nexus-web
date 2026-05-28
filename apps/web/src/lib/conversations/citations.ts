import type { ReaderCitationData } from "@/components/ui/MarkdownMessage";
import type { ReaderCitationColor } from "@/components/ui/ReaderCitation";
import { readerTargetFromRetrieval } from "./readerTarget";
import type { ConversationMessage, MessageRetrieval } from "./types";

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

export function buildCitations(message: ConversationMessage): ReaderCitationData[] {
  const index = message.citation_index;
  if (!index?.length) return [];
  const byId = new Map<string, MessageRetrieval>();
  for (const retrieval of message.retrievals ?? []) {
    if (retrieval.id) byId.set(retrieval.id, retrieval);
  }
  const citations: ReaderCitationData[] = [];
  for (const entry of index) {
    const retrieval = byId.get(entry.retrieval_id);
    if (!retrieval) continue;
    const target = readerTargetFromRetrieval(retrieval);
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
      href: retrieval.deep_link ?? null,
    });
  }
  return citations;
}
