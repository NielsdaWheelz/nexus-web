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
import { publishChange, useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { presentPodcast } from "@/lib/collections/presenters/podcast";
import { getLibraryPodcasts } from "@/lib/podcasts/api";
import { podcastErrorMessage } from "@/lib/podcasts/paneState";
import { useRefreshStamp } from "@/lib/consumption/refresh";
import { usePaneIsVisible } from "@/lib/panes/paneRuntime";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import type { Library } from "@/lib/libraries/api";
import PodcastImportProgress from "./PodcastImportProgress";

export default function LibraryPodcastsSection({ library, active }: { readonly library: Library; readonly active: boolean }) {
  const { ctx } = useActionRuntime();
  const visible = usePaneIsVisible();
  const source = usePaneFreeServerValue({ key: `library-podcasts:${ctx.accountId}:${library.id}`, stale: `${useChangeStamp("Podcasts", "Entries", "Libraries")}:${useRefreshStamp(active, 60_000)}`,
    load: signal => getLibraryPodcasts(library.id, signal),
  });
  const data = source.status === "ready" ? source.data : null;
  const busy = data !== null && (data.imports.some(operation => operation.state === "pending" || operation.state === "running") || data.subscriptions.some(show => show.recurring.state !== "idle" || show.imports.some(operation => operation.state === "pending" || operation.state === "running")));
  // justify-polling: imports and recurring publication have no client event stream.
  useIntervalPoll({ enabled: active && visible && busy, pollIntervalMs: 3000, onPoll: () => {
    if (document.visibilityState === "visible" && source.status === "ready" && !source.refreshing) source.refetch();
  } });
  const observed = useRef<string | null>(null);
  const signature = data === null ? null : JSON.stringify([data.order_revision, data.subscriptions.map(show => [show.podcast.id, show.recurring.last_checked_at, show.imports.map(operation => [operation.id, operation.updated_at])]), data.imports.map(operation => [operation.id, operation.updated_at])]);
  useEffect(() => {
    if (signature === null || observed.current === signature) return;
    const previous = observed.current; observed.current = signature;
    if (previous !== null) publishChange("Entries");
  }, [signature]);
  return <PaneSection title={`podcasts${data === null ? "" : ` · ${data.subscriptions.length}`}`} aria-label="podcasts" tabIndex={-1}
    actions={library.can_add_content ? <ButtonLink href={`/browse?kind=Podcast${library.is_default ? "" : `&library_id=${library.id}`}`}>add podcast…</ButtonLink> : undefined}>
    {source.status !== "loading" && source.error !== null ? <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t load library podcasts.")} announcement="Polite" actions={[{ label: "retry", onClick: source.refetch }]} /> : null}
    <CollectionView surface={false} returnScope={`Library.Podcasts:${library.id}`} ariaLabel="subscribed podcasts" status={source.status === "failed" ? "error" : source.status}
      rows={(data?.subscriptions ?? []).map(show => presentPodcast({ id: show.podcast.id, title: show.podcast.title, imageUrl: show.podcast.image_url, contributors: show.podcast.contributors, unplayedCount: null, recurring: show.recurring }))}
      rowControls={Object.fromEntries((data?.subscriptions ?? []).map(show => [show.podcast.id, <Button key={show.podcast.id} aria-haspopup="dialog"
        aria-disabled={!library.is_default && !library.can_add_content || undefined}
        tooltip={!library.is_default && !library.can_add_content ? { text: "a library admin must remove this subscription." } : undefined}
        onClick={() => ctx.overlays.open({ kind: "UnsubscribePodcast", podcastId: show.podcast.id, title: show.podcast.title, libraryId: library.is_default ? null : library.id })}>{library.is_default ? "unsubscribe…" : "remove from library…"}</Button>]))}
      rowPanels={Object.fromEntries((data?.subscriptions ?? []).map(show => [show.podcast.id, <div key={show.podcast.id}>
        <p>{library.is_default ? `new episodes added automatically to ${show.destinations.map(destination => destination.is_default ? "all" : destination.name).join(", ")}` : "new episodes added automatically"}</p>
        {show.recurring.error_code !== null || show.recurring.had_coverage_gaps ? <p>the last check could not load all available episodes. checking will retry automatically.</p> : null}
        {show.imports.map(operation => <PodcastImportProgress key={operation.id} operation={operation} title={show.podcast.title} following={show.destinations.some(destination => destination.library_id === operation.library_id)} />)}
      </div>]))}
      empty={source.status === "ready" && source.error === null ? <p>no subscribed podcasts.</p> : null} />
    {data !== null && data.imports.length > 0 ? <section aria-label="episode imports"><h3>episode imports</h3>{data.imports.map(operation => <div key={operation.id}><a href={`/podcasts/${operation.podcast_id}`}>{operation.podcast_title}</a><PodcastImportProgress operation={operation} title={operation.podcast_title} following={data.subscriptions.some(show => show.podcast.id === operation.podcast_id && show.destinations.some(destination => destination.library_id === operation.library_id))} /></div>)}</section> : null}
  </PaneSection>;
}
