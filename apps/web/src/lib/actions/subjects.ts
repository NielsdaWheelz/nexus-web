/** Finite resource subjects preserve canonical authority and supplied directory provenance. */
import type { Schema } from "@/lib/api/wire";

export type MetadataSubject =
  | { readonly kind: "Media"; readonly mediaId: string }
  | { readonly kind: "Podcast"; readonly podcastId: string }
  | { readonly kind: "Library"; readonly libraryId: string }
  | { readonly kind: "DiscoveryPodcast"; readonly candidate: Schema<"PodcastCandidate"> }
  | { readonly kind: "DiscoveryPodcastPreview"; readonly preview: Schema<"PodcastPreview"> };
