"use client";

import type { ReactNode } from "react";
import MediaInfoOverlay from "@/components/media/MediaInfoOverlay";
import { ContributorRoleGroups } from "@/components/contributors/ContributorCredits";
import PodcastArtwork from "@/components/podcasts/PodcastArtwork";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import InformationFrame from "./InformationFrame";
import { informationFact } from "./InformationFacts";
import type { MediaImageProxySrc } from "@/lib/media/imageProxy";
import { assertNever } from "@/lib/assertNever";
import type { Schema } from "@/lib/api/wire";
import type { MetadataSubject } from "@/lib/actions/subjects";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { getPodcastDetail } from "@/lib/podcasts/api";
import { podcastErrorMessage } from "@/lib/podcasts/paneState";
import { getLibraryMetadata } from "@/lib/libraries/api";
import { libraryErrorFeedback, throwDefect } from "@/lib/libraries/errors";
import { libraryDisplayName } from "@/lib/collections/presenters/library";
import { formatDisplayDate, formatDisplayNumber } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import styles from "@/components/media/MediaInfoOverlay.module.css";

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return informationFact(label, children);
}
const sourceLink = (href: string | null) => href === null ? null : <a href={href} dir="auto">{href}</a>;

function PodcastMetadata({ podcastId, open }: { readonly podcastId: string; readonly open: boolean }) {
  const display = useRenderEnvironment();
  const source = usePaneFreeServerValue({ key: open ? `metadata:podcast:${podcastId}` : null, stale: useChangeStamp("Podcasts", "Consumption", "Entries", "Metadata", "Libraries"), load: signal => getPodcastDetail(podcastId, signal) });
  if (source.status === "loading") return <PaneLoadingState label="loading metadata…" announcement="Polite" />;
  if (source.status === "failed") return <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t load metadata.")} announcement="Polite" actions={[{ label: "retry", onClick: source.refetch, busy: source.retrying }]} />;
  const { podcast, episode_counts: counts } = source.data;
  const date = (value: string) => <time dateTime={value}>{formatDisplayDate(value, display, { dateStyle: "medium", timeStyle: "short" })}</time>;
  return <div className={styles.content}>
    <h3 className={styles.resourceTitle}>{podcast.title}</h3>
    <PodcastArtwork title={podcast.title} image={podcast.image_url === null ? { kind: "Absent" } : { kind: "Remote", url: podcast.image_url }} size={96} className={styles.group} />
    <ContributorRoleGroups credits={podcast.contributors} />
    <dl className={styles.facts}>
      <Fact label="description">{podcast.description}</Fact>
      <Fact label="website">{sourceLink(podcast.website_url)}</Fact>
      <Fact label="rss feed">{sourceLink(podcast.feed_url)}</Fact>
      <Fact label="provider">{podcast.provider === "podcast_index" ? "Podcast Index" : podcast.provider}</Fact>
      <Fact label="available episodes">{formatDisplayNumber(counts.available_count, display)}</Fact>
      <Fact label="unfinished episodes">{formatDisplayNumber(counts.unfinished_count, display)}</Fact>
      <Fact label="catalog record created">{date(podcast.created_at)}</Fact>
      <Fact label="catalog record updated">{date(podcast.updated_at)}</Fact>
    </dl>
    {source.error !== null ? <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t refresh metadata.")} announcement="Polite" actions={[{ label: "retry", onClick: source.refetch, busy: source.refreshing }]} /> : null}
  </div>;
}

function LibraryMetadata({ libraryId, open }: { readonly libraryId: string; readonly open: boolean }) {
  const display = useRenderEnvironment();
  const source = usePaneFreeServerValue({ key: open ? `metadata:library:${libraryId}` : null, stale: useChangeStamp("Libraries", "Entries", "Podcasts", "Metadata"), load: signal => getLibraryMetadata(libraryId, signal) });
  if (source.status === "loading") return <PaneLoadingState label="loading library details…" announcement="Polite" />;
  if (source.status === "failed") {
    const failure = libraryErrorFeedback(source.error, "couldn’t load library details.", throwDefect);
    return failure === null ? null : <FeedbackNotice content={failure} announcement="Polite" actions={[{ label: "retry", onClick: source.refetch, busy: source.retrying }]} />;
  }
  const refreshFailure = source.error === null ? null : libraryErrorFeedback(source.error, "couldn’t refresh library details.", throwDefect);
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
    {refreshFailure !== null ? <FeedbackNotice content={refreshFailure} announcement="Polite" actions={[{ label: "retry", onClick: source.refetch, busy: source.refreshing }]} /> : null}
  </div>;
}

function DirectoryPodcastMetadata({ directory }: { readonly directory: Schema<"PodcastCandidate"> | Schema<"PodcastPreview"> }) {
  // justify-type-assertion: browse schemas issue proxy srcs for every image.
  const image = directory.image as MediaImageProxySrc | null;
  return <div className={styles.content}>
    <h3 className={styles.resourceTitle}>{directory.title}</h3>
    <p>directory metadata</p>
    {image !== null ? <PodcastArtwork title={directory.title} image={{ kind: "Proxied", url: image }} size={96} className={styles.group} /> : null}
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
    case "Media": return <MediaInfoOverlay {...frame} mediaId={subject.mediaId} />;
    case "Podcast": content = <PodcastMetadata podcastId={subject.podcastId} open={frame.open} />; break;
    case "Library": content = <LibraryMetadata libraryId={subject.libraryId} open={frame.open} />; break;
    case "DiscoveryPodcast": content = <DirectoryPodcastMetadata directory={subject.candidate} />; break;
    case "DiscoveryPodcastPreview": content = <DirectoryPodcastMetadata directory={subject.preview} />; break;
    default: return assertNever(subject, "unsupported metadata subject");
  }
  return <InformationFrame {...frame} title={subject.kind === "Library" ? "library details" : "metadata"}>{content}</InformationFrame>;
}
