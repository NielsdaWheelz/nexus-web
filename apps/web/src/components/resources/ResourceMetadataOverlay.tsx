"use client";

import type { ReactNode } from "react";
import MediaInfoOverlay from "@/components/media/MediaInfoOverlay";
import { ContributorRoleGroups } from "@/components/contributors/ContributorCredits";
import Artwork, { remoteArtwork } from "@/components/ui/Artwork";
import { Fact as FeedbackFact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import InformationFrame from "./InformationFrame";
import { informationFact } from "./InformationFacts";
import type { MediaImageProxySrc } from "@/lib/media/imageProxy";
import { isApiError } from "@/lib/api/client";
import { catalogLine } from "@/lib/catalog/copy";
import { feedRefusalReason } from "@/lib/feeds/paneState";
import { libraryReason } from "@/lib/libraries/errors";
import { assertNever } from "@/lib/assertNever";
import type { Schema } from "@/lib/api/wire";
import type { MetadataSubject } from "@/lib/actions/subjects";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { getFeedDetail } from "@/lib/feeds/api";

import { getLibraryMetadata } from "@/lib/libraries/api";
import { libraryDisplayName } from "@/lib/collections/presenters/library";
import { formatDisplayDate, formatDisplayNumber } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import styles from "@/components/media/MediaInfoOverlay.module.css";

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return informationFact(label, children);
}
const sourceLink = (href: string | null) => href === null ? null : <a href={href} dir="auto">{href}</a>;

function FeedMetadata({ feedId, open }: { readonly feedId: string; readonly open: boolean }) {
  const display = useRenderEnvironment();
  const key = open ? `metadata:podcast:${feedId}` : null;
  const source = usePaneFreeServerValue({ key, stale: useChangeStamp("Feeds", "Consumption", "Entries", "Metadata", "Libraries"), load: async signal => (await getFeedDetail(feedId, signal)).data });
  if (source.status === "loading") return <Ruling />;
  if (source.status === "failed") {
    const catalog = isApiError(source.error) ? catalogLine(source.error) : null;
    if (catalog !== null) return <FeedbackFact line={catalog}/>;
    const reason = isApiError(source.error) && ["E_NOT_FOUND", "E_FEED_NOT_FOUND", "E_MEDIA_NOT_FOUND"].includes(source.error.code)
      ? feedRefusalReason(source.error) : undefined;
    return reason === undefined ? <Failed error={source.error} noun="source details" retry={{run: source.refetch, busy: source.retrying}}/>
      : <FeedbackFact line={{fact: "couldn’t load source details.", reason}}/>;
  }
  const { feed: podcast, entry_counts: counts } = source.data;
  const date = (value: string) => <time dateTime={value}>{formatDisplayDate(value, display, { dateStyle: "medium", timeStyle: "short" })}</time>;
  return <div className={styles.content}>
    <h3 className={styles.resourceTitle}>{podcast.title}</h3>
    <Artwork title={podcast.title} source={remoteArtwork(podcast.image_url)} size={96} className={styles.group} />
    <ContributorRoleGroups credits={podcast.contributors} />
    <dl className={styles.facts}>
      <Fact label="description">{podcast.description}</Fact>
      <Fact label="website">{sourceLink(podcast.website_url)}</Fact>
      <Fact label="rss feed">{sourceLink(podcast.feed_url)}</Fact>
      <Fact label="provider">{podcast.provider === "podcast_index" ? "Podcast Index" : podcast.provider}</Fact>
      <Fact label={`known ${podcast.kind === "podcast" ? "episodes" : "articles"}`}>{formatDisplayNumber(counts.known_count, display)}</Fact>
      <Fact label={`unfinished ${podcast.kind === "podcast" ? "episodes" : "articles"}`}>{formatDisplayNumber(counts.unfinished_count, display)}</Fact>
      <Fact label="catalog record created">{date(podcast.created_at)}</Fact>
      <Fact label="catalog record updated">{date(podcast.updated_at)}</Fact>
    </dl>
  </div>;
}

function LibraryMetadata({ libraryId, open }: { readonly libraryId: string; readonly open: boolean }) {
  const display = useRenderEnvironment();
  const key = open ? `metadata:library:${libraryId}` : null;
  const source = usePaneFreeServerValue({ key, stale: useChangeStamp("Libraries", "Entries", "Feeds", "Metadata"), load: signal => getLibraryMetadata(libraryId, signal) });
  if (source.status === "loading") return <Ruling />;
  if (source.status === "failed") {
    const catalog = isApiError(source.error) ? catalogLine(source.error) : null;
    if (catalog !== null) return <FeedbackFact line={catalog}/>;
    const reason = isApiError(source.error) && source.error.code === "E_LIBRARY_NOT_FOUND" ? libraryReason(source.error) : null;
    return reason === null ? <Failed error={source.error} noun="library details" retry={{run: source.refetch, busy: source.retrying}}/>
      : <FeedbackFact line={{fact: "couldn’t load library details.", reason}}/>;
  }
  const metadata = source.data;
  const date = (value: string) => <time dateTime={value}>{formatDisplayDate(value, display, { dateStyle: "medium", timeStyle: "short" })}</time>;
  return <div className={styles.content}>
    <h3 className={styles.resourceTitle}>{libraryDisplayName(metadata.library)}</h3>
    <dl className={styles.facts}>
      <Fact label="kind">{metadata.kind}</Fact>
      <Fact label="your role">{metadata.library.role}</Fact>
      <Fact label="items">{formatDisplayNumber(metadata.media_count, display)}</Fact>
      <Fact label="created">{date(metadata.created_at)}</Fact>
      <Fact label="updated">{date(metadata.updated_at)}</Fact>
    </dl>
  </div>;
}

function DirectoryFeedMetadata({ directory }: { readonly directory: Schema<"PodcastCandidate"> | Schema<"PodcastPreview"> }) {
  // justify-type-assertion: browse schemas issue proxy srcs for every image.
  const image = directory.image as MediaImageProxySrc | null;
  return <div className={styles.content}>
    <h3 className={styles.resourceTitle}>{directory.title}</h3>
    <p>directory metadata</p>
    {image !== null ? <Artwork title={directory.title} source={{ kind: "Proxied", url: image }} size={96} className={styles.group} /> : null}
    <ContributorRoleGroups credits={directory.contributors} />
    <dl className={styles.facts}>
      <Fact label="description">{directory.description}</Fact>
      <Fact label="provider">Podcast Index</Fact>
      <Fact label="website">{sourceLink(directory.kind_facts.website_href)}</Fact>
      <Fact label="rss feed">{sourceLink(directory.kind_facts.feed_href)}</Fact>
    </dl>
  </div>;
}

/** Inspection uses supplied directory facts or one explicit local domain read. */
export default function ResourceMetadataOverlay(props: {
  readonly subject: MetadataSubject;
  readonly open: boolean;
  readonly returnFocusTo: ReturnFocusTarget;
  readonly returnFocusFallback: ReturnFocusTarget;
  readonly skipReturnFocus?: () => boolean;
  readonly onClose: () => void;
}) {
  const { subject, ...frame } = props;
  let content: ReactNode;
  switch (subject.kind) {
    case "Media": return <MediaInfoOverlay {...frame} mediaId={subject.mediaId} jobId={subject.jobId} />;
    case "Feed": content = <FeedMetadata feedId={subject.feedId} open={frame.open} />; break;
    case "Library": content = <LibraryMetadata libraryId={subject.libraryId} open={frame.open} />; break;
    case "DiscoveryPodcast": content = <DirectoryFeedMetadata directory={subject.candidate} />; break;
    case "DiscoveryPodcastPreview": content = <DirectoryFeedMetadata directory={subject.preview} />; break;
    default: return assertNever(subject, "unsupported metadata subject");
  }
  return <InformationFrame {...frame} title={subject.kind === "Library" ? "library details" : "metadata"}>{content}</InformationFrame>;
}
