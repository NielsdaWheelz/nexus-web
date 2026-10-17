// Citation rendering consumes the graph's frozen occurrence projection.
import type { Schema } from "@/lib/api/wire";
import type { SourceLocator } from "@/lib/resources/sourceTarget";

export type CitationOut = Schema<"CitationOut">;
export type RetrievalLocator = SourceLocator;
export interface ReaderCitationData {
  readonly index: number;
  readonly edgeId: string;
  readonly item: CitationOut["item"];
}
export const toReaderCitationData = (citation: CitationOut): ReaderCitationData => ({
  index: citation.ordinal,
  edgeId: citation.edge_id,
  item: citation.item,
});
