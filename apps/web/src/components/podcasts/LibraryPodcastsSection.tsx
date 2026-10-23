"use client";

/** Library subscriptions live above ordinary media sorting and paging. The
 * default section aggregates current member destinations and deduplicates shows.
 */
import { useEffect, useId, useRef } from "react";
import CollectionView from "@/components/collections/CollectionView";
import CollectionRow from "@/components/collections/CollectionRow";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import PaneSection from "@/components/ui/PaneSection";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { projectPodcastLibraryRemovalAction, projectPodcastSubscriptionAction } from "@/lib/actions/project";
import { publishChange, useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { presentPodcast } from "@/lib/collections/presenters/podcast";
import { getLibraryPodcasts } from "@/lib/podcasts/api";
import { PODCAST_BROWSE_ACTION } from "@/lib/podcasts/navigation";
import { podcastErrorMessage } from "@/lib/podcasts/paneState";
import { useRefreshStamp } from "@/lib/consumption/refresh";
import { usePaneIsVisible } from "@/lib/panes/paneRuntime";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import type { Library } from "@/lib/libraries/api";
import { prepareActionSelect } from "@/lib/ui/actionDescriptor";
import { findPaneCollectionRowFocusTarget, findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import PodcastImportProgress from "./PodcastImportProgress";

export default function LibraryPodcastsSection({ library, active }: { readonly library: Library; readonly active: boolean }) {
  const { ctx, run } = useActionRuntime();
  const card = useRef<HTMLElement>(null);
  const browse = useRef<HTMLAnchorElement>(null);
  const reasonId = useId();
  const visible = usePaneIsVisible();
  const source = usePaneFreeServerValue({ key: `library-podcasts:${ctx.accountId}:${library.id}`, stale: `${useChangeStamp("Podcasts", "Entries", "Libraries")}:${useRefreshStamp(active, 60_000)}`,
    load: signal => getLibraryPodcasts(library.id, signal),
  });
  const data = source.status === "ready" ? source.data : null;
  const blocked = source.status !== "ready" || source.error !== null || source.refreshing ? "TemporarilyUnavailable" : null;
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
  return <PaneSection ref={card} title={`podcasts${data === null ? "" : ` · ${data.subscriptions.length}`}`} aria-label="podcasts" tabIndex={-1}
    actions={<ButtonLink ref={browse} href={PODCAST_BROWSE_ACTION.href} iconOnly icon={PODCAST_BROWSE_ACTION.icon} aria-label={PODCAST_BROWSE_ACTION.label} />}>
    {source.status !== "loading" && source.error !== null ? <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t load library podcasts.")} announcement="Polite" actions={[{ label: "retry", onClick: source.refetch }]} /> : null}
    <CollectionView surface={false} returnScope={`Library.Podcasts:${library.id}`} ariaLabel="subscribed podcasts" status={source.status === "failed" ? "error" : source.status}
      rows={(data?.subscriptions ?? []).map(show => presentPodcast({ id: show.podcast.id, title: show.podcast.title, imageUrl: show.podcast.image_url, contributors: show.podcast.contributors, unplayedCount: null, recurring: show.recurring }))}
      renderRow={props => {
        const { row } = props;
        const captureSuccessFocus = () => {
          const paneId = card.current?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
          const rows = Array.from(card.current?.querySelectorAll<HTMLElement>("[data-collection-row-id]") ?? []);
          const after = rows.slice(rows.findIndex(item => item.dataset.collectionRowId === row.id) + 1).map(item => item.dataset.collectionRowId!);
          return () => after.map(id => findPaneCollectionRowFocusTarget(paneId, id)).find(target => target !== null)
            ?? browse.current ?? card.current ?? findPaneLandmarkFocusTarget(paneId);
        };
        const local = library.is_default ? null : projectPodcastLibraryRemovalAction({
          podcastId: row.id, title: row.title.text, libraryId: library.id, libraryName: library.name,
          canRemove: library.can_add_content, blocked, captureSuccessFocus, ctx, run,
        });
        const action = local ?? projectPodcastSubscriptionAction({
          podcastId: row.id, title: row.title.text, subscribed: true, blocked, captureSuccessFocus, ctx, run,
        });
        const label = local?.accessibleLabel ?? action.label;
        const descriptionId = `${reasonId}-${row.id}`;
        return <CollectionRow {...props} compactPrimaryControl capturePodcastRemovalFocus={captureSuccessFocus}
          occurrenceActions={local === null ? undefined : [local]}
          primaryControl={<>
            <Button iconOnly icon={action.icon} aria-label={label} aria-haspopup="dialog"
              aria-disabled={action.disabled} aria-describedby={action.disabledReason ? descriptionId : undefined}
              tooltip={{ text: action.disabledReason ? `${label}: ${action.disabledReason}` : label }}
              onClick={event => { const detail = prepareActionSelect(event, event.currentTarget); if (detail) action.onSelect(detail); }} />
            {action.disabledReason ? <span className="sr-only" id={descriptionId}>{action.disabledReason}</span> : null}
          </>} />;
      }}
      rowPanels={Object.fromEntries((data?.subscriptions ?? []).flatMap(show => show.recurring.error_code !== null || show.recurring.had_coverage_gaps || show.imports.length > 0 ? [[show.podcast.id, <div key={show.podcast.id}>
        {show.recurring.error_code !== null || show.recurring.had_coverage_gaps ? <p>the last check could not load all available episodes. checking will retry automatically.</p> : null}
        {show.imports.map(operation => <PodcastImportProgress key={operation.id} operation={operation} title={show.podcast.title} following={show.destinations.some(destination => destination.library_id === operation.library_id)} />)}
      </div>]] : []))}
      empty={source.status === "ready" && source.error === null ? <p>no subscribed podcasts.</p> : null} />
    {data !== null && data.imports.length > 0 ? <section aria-label="episode imports"><h3>episode imports</h3>{data.imports.map(operation => <div key={operation.id}><a href={`/podcasts/${operation.podcast_id}`}>{operation.podcast_title}</a><PodcastImportProgress operation={operation} title={operation.podcast_title} following={data.subscriptions.some(show => show.podcast.id === operation.podcast_id && show.destinations.some(destination => destination.library_id === operation.library_id))} /></div>)}</section> : null}
  </PaneSection>;
}
