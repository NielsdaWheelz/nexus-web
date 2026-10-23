/** Browse result rows: candidates and podcast-preview episodes. */

import type { PodcastActionSubject } from "@/lib/actions/inlineActions";
import {
  browsePreviewHref,
  type BrowseCandidate,
  type PreviewEpisode,
} from "@/lib/browse/api";
import { BROWSE_SOURCE_LABELS } from "@/lib/browse/query";
import { presentMedia } from "@/lib/collections/presenters/media";
import type { CollectionRowView } from "@/lib/collections/types";
import { selectMediaAuthors } from "@/lib/contributors/credits";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";

/** An InNexusMedia candidate carries its resolved media summary. */
export function presentBrowseCandidate(
  candidate: BrowseCandidate,
  podcast?: PodcastActionSubject,
): CollectionRowView {
  const { resolution } = candidate;
  const id = candidate.kind === "OwnedMedia"
    ? `${candidate.source}:owned:${candidate.resolution.action_ref}`
    : `${candidate.source}:target:${candidate.target}`;
  if (resolution.kind === "InNexusMedia") {
    return presentMedia(resolution.media_summary, {
      id,
      primary: {
        kind: "link",
        href: resolution.href,
      },
      resourceRef: assumeCanonicalResourceRef(resolution.action_ref),
      selected: false,
    });
  }
  if (candidate.kind === "OwnedMedia") {
    // justify-defect: the schema gives every owned candidate InNexusMedia.
    throw new Error("Owned browse candidate without a media resolution");
  }
  const source = BROWSE_SOURCE_LABELS[candidate.source];
  const local = podcast?.facts.kind === "Ready" && podcast.facts.resolution.kind === "Canonical" ? podcast.facts.resolution : null;
  if (candidate.kind === "Podcast" && podcast === undefined) throw new Error("podcast browse row requires current action facts");
  const preview = candidate.kind === "Podcast" ? local === null : resolution.kind === "Preview";
  return {
    id,
    kind: candidate.kind === "Podcast" ? "podcast" : "search_result",
    ...(podcast === undefined ? {} : { resourceActions: { kind: "Podcast" as const, subject: podcast } }),
    ...(candidate.kind !== "Podcast" && preview ? {
      resourceActions: {
        kind: "Media" as const,
        subject: {
          kind: "External" as const,
          target: candidate.target,
          media_kind: candidate.kind === "Epub" ? "epub" as const
            : candidate.kind === "Video" ? "video" as const : "web_article" as const,
          title: candidate.title,
          contributors: candidate.contributors,
          publication_date: candidate.published_at,
        },
        knownDescriptor: null,
      },
    } : {}),
    primary: {
      kind: "link",
      href: candidate.kind === "Podcast" ? local !== null ? `/podcasts/${local.podcast_id}` : browsePreviewHref(candidate.target)
        : resolution.kind === "Preview" ? browsePreviewHref(candidate.target) : resolution.href,
      paneLabelHint: candidate.title,
    },
    title: { text: candidate.title },
    contributors:
      candidate.kind === "Podcast"
        ? candidate.contributors
        : selectMediaAuthors(candidate.contributors),
    publicationDate: candidate.published_at,
    context: {
      kind: "Text",
      text: preview ? source : `${source} · In Nexus`,
    },
    activity: null,
    exceptionalStatus: null,
    resourceRef: candidate.kind === "Podcast" ? local === null ? null : assumeCanonicalResourceRef(`podcast:${local.podcast_id}`)
      : resolution.kind === "Preview" ? null : assumeCanonicalResourceRef(resolution.action_ref),
    selected: false,
  };
}

export function presentPreviewEpisode(
  episode: PreviewEpisode,
): CollectionRowView {
  return {
    id: `PodcastIndex:episode:${episode.target}`,
    kind: "search_result",
    resourceActions: {
      kind: "Media" as const,
      subject: {
        kind: "External",
        target: episode.target,
        media_kind: "podcast_episode",
        title: episode.title,
        contributors: episode.contributors,
        publication_date: episode.published_at,
      },
      knownDescriptor: null,
    },
    primary: {
      kind: "link",
      href: browsePreviewHref(episode.target),
      paneLabelHint: episode.title,
    },
    title: { text: episode.title },
    contributors: selectMediaAuthors(episode.contributors),
    publicationDate: episode.published_at,
    context: {
      kind: "Text",
      text: `Podcast Index · ${episode.kind_facts.podcast_title}`,
    },
    activity: null,
    exceptionalStatus: null,
    resourceRef: null,
    selected: false,
  };
}
