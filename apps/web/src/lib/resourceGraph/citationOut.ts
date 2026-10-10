import type { Schema } from "@/lib/api/wire";

/** The shared `[N]` citation. `media_id` is the jump anchor: for an
 * evidence_span citation, `target_ref.id` is the span, NOT the media. */
export type CitationOut = Schema<"CitationOut">;

export type RetrievalLocator = NonNullable<CitationOut["locator"]>;
