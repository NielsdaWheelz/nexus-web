import type { Schema } from "@/lib/api/wire";

export type MediaDuration = Schema<"MediaDurationOut">;
export type MediaSummary = Schema<"MediaSummaryOut">;

/** A stored identity or an external occurrence; provenance is never an import source. */
export type MediaSubject =
  | { readonly kind: "Stored"; readonly summary: MediaSummary }
  | {
      readonly kind: "External";
      readonly target: string;
      readonly media_kind: MediaSummary["media_kind"];
      readonly title: string;
      readonly contributors: readonly Schema<"ContributorCreditOut">[];
      readonly publication_date: string | null;
    };
