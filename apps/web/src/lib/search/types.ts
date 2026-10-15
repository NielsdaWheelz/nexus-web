import type { ApiJson } from "@/lib/api/wire";
import type { ContributorCredit } from "@/lib/contributors/credits";
import type { MediaSummary } from "@/lib/media/mediaSummary";
import type { ResourceActivation } from "@/lib/resources/activation";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import type { EmphasisSegment } from "@/lib/ui/emphasis";

export type SearchType = ApiJson<"/search", "get">["results"][number]["type"];

/** One search hit as the pane and Nexus show it; it always opens somewhere. */
export type SearchResultRowViewModel = {
  key: string;
  score: number;
  resourceRef: string;
  ownerResourceRef: string;
  activation: ResourceActivation & { href: string };
  actionRef: CanonicalResourceRef;
  snippetSegments: readonly EmphasisSegment[];
} & (
  | { type: "media" | "episode" | "video"; mediaSummary: MediaSummary }
  | {
      type: Exclude<SearchType, "media" | "episode" | "video">;
      typeLabel: string;
      primaryText: string;
      sourceMeta: string | null;
      publicationDate: string | null;
      contributorCredits: ContributorCredit[];
    }
);

export interface SearchResultPage {
  rows: SearchResultRowViewModel[];
  nextCursor: string | null;
}
