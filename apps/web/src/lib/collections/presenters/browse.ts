import { absent, present } from "@/lib/api/presence";
import type { Presence } from "@/lib/api/presence";
import { presentMedia } from "@/lib/collections/presenters/media";
import { decodePublicationDate, type PublicationDate } from "@/lib/dates/publicationDate";
import { mediaSummaryFromWire } from "@/lib/media/mediaSummary";
import { decodeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import {
  browsePreviewHref,
  type BrowseCandidate,
  type BrowseKind,
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

export function browseKindLabel(kind: BrowseKind): string {
  switch (kind) {
    case "Pdf":
      return "PDF";
    case "Epub":
      return "EPUB";
    case "WebArticle":
      return "Web Article";
    case "Video":
      return "Video";
    case "Podcast":
      return "Podcast";
  }
}

function candidateHref(candidate: BrowseCandidate): string {
  switch (candidate.resolution.kind) {
    case "InNexusMedia":
    case "InNexusPodcast":
      return candidate.resolution.href;
    case "Preview":
      return browsePreviewHref(candidate.resolution.target);
  }
}

function candidateId(candidate: BrowseCandidate): string {
  switch (candidate.resolution.kind) {
    case "InNexusMedia":
    case "InNexusPodcast":
      return `${candidate.source}:owned:${candidate.resolution.href}`;
    case "Preview":
      return `${candidate.source}:preview:${candidate.resolution.target}`;
  }
}

function publicationDate(value: Presence<string>): Presence<PublicationDate> {
  return value.kind === "Present"
    ? present(decodePublicationDate(value.value, "Browse.publishedAt.value"))
    : absent();
}

export function presentBrowseCandidate(
  candidate: BrowseCandidate,
): CollectionRowView {
  if (candidate.resolution.kind === "InNexusMedia") {
    return presentMedia(mediaSummaryFromWire(candidate.resolution.mediaSummary), {
      id: candidateId(candidate),
      primary: {
        kind: "link",
        href: candidate.resolution.href,
        viewTransition: "media-reader",
      },
      actionSubject: decodeResourceActionSubject({ ref: candidate.resolution.actionSubjectRef }),
      selected: false,
    });
  }
  if (candidate.kind === "OwnedMedia") {
    throw new Error("Owned browse media missing media summary");
  }
  const source = browseSourceLabel(candidate.source);
  const context =
    candidate.resolution.kind === "InNexusPodcast"
      ? `${source} · In Nexus`
      : source;
  return {
    id: candidateId(candidate),
    kind: "search_result",
    primary: {
      kind: "link",
      href: candidateHref(candidate),
      paneLabelHint: candidate.title,
    },
    title: { text: candidate.title },
    contributors: candidate.contributors,
    publicationDate: publicationDate(candidate.publishedAt),
    context: present({ kind: "Text", text: context }),
    activity: absent(),
    exceptionalStatus: absent(),
    localAvailability: absent(),
    actionSubject:
      candidate.resolution.kind === "InNexusPodcast"
        ? decodeResourceActionSubject({ ref: candidate.resolution.actionSubjectRef })
        : null,
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
    publicationDate: publicationDate(episode.publishedAt),
    context: present({
      kind: "Text",
      text: `Podcast Index · ${episode.kindFacts.podcastTitle}`,
    }),
    activity: absent(),
    exceptionalStatus: absent(),
    localAvailability: absent(),
    actionSubject: null,
    selected: false,
  };
}
