/** Browse result rows: candidates and podcast-preview episodes. */

import { absent, present } from "@/lib/api/presence";
import {
  browsePreviewHref,
  type BrowseCandidate,
  type PreviewEpisode,
} from "@/lib/browse/api";
import { BROWSE_SOURCE_LABELS } from "@/lib/browse/query";
import { presentMedia } from "@/lib/collections/presenters/media";
import type { CollectionRowView } from "@/lib/collections/types";
import { selectMediaAuthors } from "@/lib/contributors/formatting";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";

/** An InNexusMedia candidate carries its resolved media summary. */
export function presentBrowseCandidate(
  candidate: BrowseCandidate,
): CollectionRowView {
  const { resolution } = candidate;
  if (resolution.kind === "InNexusMedia") {
    return presentMedia(resolution.mediaSummary, {
      id: `${candidate.source}:owned:${resolution.href}`,
      primary: {
        kind: "link",
        href: resolution.href,
        viewTransition: "media-reader",
      },
      actionSubject: {
        ref: assumeCanonicalResourceRef(resolution.actionSubjectRef),
      },
      selected: false,
    });
  }
  if (candidate.kind === "OwnedMedia") {
    // justify-defect: the schema gives every owned candidate InNexusMedia.
    throw new Error("Owned browse candidate without a media resolution");
  }
  const source = BROWSE_SOURCE_LABELS[candidate.source];
  const preview = resolution.kind === "Preview";
  return {
    id: preview
      ? `${candidate.source}:preview:${resolution.target}`
      : `${candidate.source}:owned:${resolution.href}`,
    kind: "search_result",
    primary: {
      kind: "link",
      href: preview ? browsePreviewHref(resolution.target) : resolution.href,
      paneLabelHint: candidate.title,
    },
    title: { text: candidate.title },
    contributors:
      candidate.kind === "Podcast"
        ? candidate.contributors
        : selectMediaAuthors(candidate.contributors),
    publicationDate: candidate.publishedAt,
    context: present({
      kind: "Text",
      text: preview ? source : `${source} · In Nexus`,
    }),
    activity: absent(),
    exceptionalStatus: absent(),
    actionSubject: preview
      ? null
      : { ref: assumeCanonicalResourceRef(resolution.actionSubjectRef) },
    selected: false,
  };
}

export function presentPreviewEpisode(
  episode: PreviewEpisode,
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
    contributors: selectMediaAuthors(episode.contributors),
    publicationDate: episode.publishedAt,
    context: present({
      kind: "Text",
      text: `Podcast Index · ${episode.kindFacts.podcastTitle}`,
    }),
    activity: absent(),
    exceptionalStatus: absent(),
    actionSubject: null,
    selected: false,
  };
}
