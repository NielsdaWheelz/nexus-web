import { absent, present } from "@/lib/api/presence";
import {
  browsePreviewHref,
  type BrowseCandidate,
  type BrowseSource,
  type PreviewEpisodeItem,
} from "@/lib/browse/contract";
import type { CollectionRowView } from "@/lib/collections/types";

export function browseSourceLabel(source: BrowseSource): string {
  switch (source) {
    case "Nexus":
      return "Nexus";
    case "ProjectGutenberg":
      return "Project Gutenberg";
    case "Brave":
      return "Brave";
    case "YouTube":
      return "YouTube";
    case "PodcastIndex":
      return "Podcast Index";
  }
}

function candidateHref(candidate: BrowseCandidate): string {
  switch (candidate.resolution.kind) {
    case "InNexus":
      return candidate.resolution.href;
    case "Preview":
      return browsePreviewHref(candidate.resolution.target);
    case "ExternalOnly":
      return candidate.resolution.sourceHref;
  }
}

function candidateId(candidate: BrowseCandidate): string {
  switch (candidate.resolution.kind) {
    case "InNexus":
      return `${candidate.source}:owned:${candidate.resolution.href}`;
    case "Preview":
      return `${candidate.source}:preview:${candidate.resolution.target}`;
    case "ExternalOnly":
      return `${candidate.source}:external:${candidate.resolution.sourceHref}`;
  }
}

export function presentBrowseCandidate(
  candidate: BrowseCandidate,
): CollectionRowView {
  const external = candidate.resolution.kind === "ExternalOnly";
  const source = browseSourceLabel(candidate.source);
  const context =
    candidate.resolution.kind === "InNexus" && candidate.source !== "Nexus"
      ? `${source} · In Nexus`
      : source;
  return {
    id: candidateId(candidate),
    kind: "search_result",
    primary: {
      kind: "link",
      href: candidateHref(candidate),
      paneLabelHint: candidate.title,
      ...(external ? { target: "_blank" as const, rel: "noreferrer" } : {}),
    },
    title: { text: candidate.title },
    contributors: candidate.contributors,
    publicationDate: candidate.publishedAt,
    context: present({ kind: "Text", text: context }),
    activity: absent(),
    exceptionalStatus: absent(),
    connections: absent(),
    relatedMediaId: absent(),
    actionPublication: { kind: "FlatMenu", actions: [] },
    selected: false,
  };
}

export function presentPreviewEpisode(
  episode: PreviewEpisodeItem,
): CollectionRowView {
  return {
    id: `PodcastIndex:episode:${episode.target}`,
    kind: "search_result",
    primary: {
      kind: "link",
      href: browsePreviewHref(episode.target),
      paneLabelHint: episode.title,
    },
    title: { text: episode.title },
    contributors: episode.contributors,
    publicationDate: episode.publishedAt,
    context: present({
      kind: "Text",
      text: `Podcast Index · ${episode.kindFacts.podcastTitle}`,
    }),
    activity: absent(),
    exceptionalStatus: absent(),
    connections: absent(),
    relatedMediaId: absent(),
    actionPublication: { kind: "FlatMenu", actions: [] },
    selected: false,
  };
}
