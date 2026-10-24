"use client";

/** Library subscriptions live above ordinary media sorting and paging. The
 * default section aggregates current member destinations and deduplicates shows.
 */
import { useEffect, useRef } from "react";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import PaneSection from "@/components/ui/PaneSection";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { publishChange } from "@/lib/api/changes";
import type { ServerValue } from "@/lib/api/serverState";
import { remoteReady } from "@/lib/native/admission";
import { presentPodcast } from "@/lib/collections/presenters/podcast";
import type { PodcastSection } from "@/lib/podcasts/api";
import { podcastErrorMessage } from "@/lib/podcasts/paneState";
import { usePaneIsVisible } from "@/lib/panes/paneRuntime";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import type { Library } from "@/lib/libraries/api";
import PodcastImportProgress from "./PodcastImportProgress";

export default function LibraryPodcastsSection({ library, active, source }: { readonly library: Library; readonly active: boolean; readonly source: ServerValue<PodcastSection> }) {
  const { ctx } = useActionRuntime();
  const visible = usePaneIsVisible();
  const data = source.status === "ready" ? source.data : null;
  const live = source.status === "ready" && source.source.kind === "live";
  const manage = live && remoteReady();
  const busy = data !== null && (data.imports.some(operation => operation.state === "pending" || operation.state === "running") || data.subscriptions.some(show => show.recurring.state !== "idle" || show.imports.some(operation => operation.state === "pending" || operation.state === "running")));
  // justify-polling: imports and recurring publication have no client event stream.
  useIntervalPoll({ enabled: manage && active && visible && busy, pollIntervalMs: 3000, onPoll: () => {
    if (document.visibilityState === "visible" && source.status === "ready" && !source.refreshing) source.refetch();
  } });
  const observed = useRef<string | null>(null);
  const signature = data === null ? null : JSON.stringify([data.order_revision, data.subscriptions.map(show => [show.podcast.id, show.recurring.last_checked_at, show.imports.map(operation => [operation.id, operation.updated_at])]), data.imports.map(operation => [operation.id, operation.updated_at])]);
  useEffect(() => {
    if (!live) { observed.current = null; return; }
    if (signature === null || observed.current === signature) return;
    const previous = observed.current; observed.current = signature;
    if (previous !== null) publishChange("Entries");
  }, [signature, live]);
  return <PaneSection title={`podcasts${data === null ? "" : ` · ${data.subscriptions.length}`}`} aria-label="podcasts" tabIndex={-1}
    actions={manage && library.can_add_content ? <ButtonLink href={`/browse?kind=Podcast${library.is_default ? "" : `&library_id=${library.id}`}`}>add podcast…</ButtonLink> : undefined}>
    {source.status !== "loading" && source.error !== null ? <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t load library podcasts.")} announcement="Polite" actions={[{ label: "retry", onClick: source.refetch }]} /> : null}
    <CollectionView surface={false} returnScope={`Library.Podcasts:${library.id}`} ariaLabel="subscribed podcasts" status={source.status === "failed" ? "error" : source.status}
      rows={(data?.subscriptions ?? []).map(show => presentPodcast({ id: show.podcast.id, title: show.podcast.title, imageUrl: show.podcast.image_url, contributors: show.podcast.contributors, unplayedCount: null, recurring: live ? show.recurring : null }))}
      rowControls={manage ? Object.fromEntries((data?.subscriptions ?? []).map(show => [show.podcast.id, <Button key={show.podcast.id} aria-haspopup="dialog"
        aria-disabled={!library.is_default && !library.can_add_content || undefined}
        tooltip={!library.is_default && !library.can_add_content ? { text: "a library admin must remove this subscription." } : undefined}
        onClick={() => ctx.overlays.open({ kind: "UnsubscribePodcast", podcastId: show.podcast.id, title: show.podcast.title, libraryId: library.is_default ? null : library.id })}>{library.is_default ? "unsubscribe…" : "remove from library…"}</Button>])) : undefined}
      rowPanels={Object.fromEntries((data?.subscriptions ?? []).map(show => [show.podcast.id, <div key={show.podcast.id}>
        <p>{library.is_default ? `new episodes added automatically to ${show.destinations.map(destination => destination.is_default ? "all" : destination.name).join(", ")}` : "new episodes added automatically"}</p>
        {show.recurring.error_code !== null || show.recurring.had_coverage_gaps ? <p>the last check could not load all available episodes. checking will retry automatically.</p> : null}
        {!live ? <p>at last catalog save</p> : null}
        {live ? show.imports.map(operation => <PodcastImportProgress key={operation.id} operation={operation} title={show.podcast.title} following={show.destinations.some(destination => destination.library_id === operation.library_id)} />) : null}
      </div>]))}
      empty={source.status === "ready" && source.error === null ? <p>no subscribed podcasts.</p> : null} />
    {live && data !== null && data.imports.length > 0 ? <section aria-label="episode imports"><h3>episode imports</h3>{data.imports.map(operation => <div key={operation.id}><a href={`/podcasts/${operation.podcast_id}`}>{operation.podcast_title}</a><PodcastImportProgress operation={operation} title={operation.podcast_title} following={data.subscriptions.some(show => show.podcast.id === operation.podcast_id && show.destinations.some(destination => destination.library_id === operation.library_id))} /></div>)}</section> : null}
  </PaneSection>;
}
