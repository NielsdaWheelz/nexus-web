import type { EmphasisSegment } from "@/lib/ui/emphasis";
import type { ContributorCredit } from "@/lib/contributors/credits";
import type { ResourceActivation } from "@/lib/resources/activation";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { Presence } from "@/lib/api/presence";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import type { MediaSummary } from "@/lib/media/mediaSummary";
import type { ApiJson } from "@/lib/api/wire";

export type SearchType = ApiJson<"/search", "get">["results"][number]["type"];

interface SearchResultRowBase {
  key: string;
  score: number;
  resourceRef: string;
  ownerResourceRef: string;
  activation: ResourceActivation;
  actionSubject: ResourceActionSubject;
  snippetSegments: readonly EmphasisSegment[];
}

export type SearchResultRowViewModel = SearchResultRowBase & (
  | {
      type: "media" | "episode" | "video";
      mediaSummary: MediaSummary;
    }
  | {
      type: Exclude<SearchType, "media" | "episode" | "video">;
      paneLabelHint: string;
      typeLabel: string;
      primaryText: string;
      sourceMeta: string | null;
      publicationDate: Presence<PublicationDate>;
      contributorCredits: ContributorCredit[];
    }
);

export interface SearchResultPage {
  rows: SearchResultRowViewModel[];
  nextCursor: string | null;
}
