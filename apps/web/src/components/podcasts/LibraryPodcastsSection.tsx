"use client";

/** Library cards promote one removal command: global in all, scoped in named
 * libraries. Current reads gate shortcuts; canonical menus prepare their own facts.
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
import { publishChange } from "@/lib/api/changes";
import type { ServerValue } from "@/lib/api/serverState";
import { remoteReady } from "@/lib/native/admission";
import { presentPodcast } from "@/lib/collections/presenters/podcast";
import type { PodcastSection } from "@/lib/podcasts/api";
import { PODCAST_BROWSE_ACTION } from "@/lib/podcasts/navigation";
import { podcastErrorMessage } from "@/lib/podcasts/paneState";
import { usePaneIsVisible } from "@/lib/panes/paneRuntime";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import type { Library } from "@/lib/libraries/api";
import { prepareActionSelect } from "@/lib/ui/actionDescriptor";
import { findPaneCollectionRowFocusTarget, findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import PodcastImportProgress from "./PodcastImportProgress";

export default function LibraryPodcastsSection({ library, active, source, sourceStale }: { readonly library: Library; readonly active: boolean; readonly source: ServerValue<PodcastSection>; readonly sourceStale: string }) {
  const { ctx, run } = useActionRuntime();
  const card = useRef<HTMLElement>(null);
  const browse = useRef<HTMLAnchorElement>(null);
  const reasonId = useId();
  const visible = usePaneIsVisible();
  const authority = useRef<{ stale: string; generation: number | null }>({ stale: sourceStale, generation: null });
  if (authority.current.stale !== sourceStale) authority.current = { stale: sourceStale, generation: source.status === "ready" ? source.generation : null };
  const data = source.status === "ready" ? source.data : null;
  const live = source.status === "ready" && source.source.kind === "live";
  const manage = live && remoteReady();
  const blocked = !manage || source.status !== "ready" || source.error !== null || source.refreshing || source.generation === authority.current.generation ? "TemporarilyUnavailable" : null;
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
  return <PaneSection ref={card} title={`podcasts${data === null ? "" : ` · ${data.subscriptions.length}`}`} aria-label="podcasts" tabIndex={-1}
    actions={<ButtonLink ref={browse} href={PODCAST_BROWSE_ACTION.href} iconOnly icon={PODCAST_BROWSE_ACTION.icon}
      aria-label={PODCAST_BROWSE_ACTION.label} tooltip={{ text: PODCAST_BROWSE_ACTION.label }} />}>
    {source.status !== "loading" && source.error !== null ? <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t load library podcasts.")} announcement="Polite" actions={[{ label: "retry", onClick: source.refetch }]} /> : null}
    <CollectionView surface={false} returnScope={`Library.Podcasts:${library.id}`} ariaLabel="subscribed podcasts" status={source.status === "failed" ? "error" : source.status}
      rows={(data?.subscriptions ?? []).map(show => presentPodcast({ facts: null, id: show.podcast.id, title: show.podcast.title, imageUrl: show.podcast.image_url, contributors: show.podcast.contributors, unplayedCount: null, recurring: live ? show.recurring : null }))}
      renderRow={manage ? props => {
        const { row } = props;
        const focus = {
          trigger: null,
          returnFocus: () => card.current?.querySelector<HTMLElement>(`[data-collection-row-id="${CSS.escape(row.id)}"] [data-row-actions-control]`)
            ?? browse.current ?? card.current,
          get afterRemoval() {
            const paneId = card.current?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
            const rows = Array.from(card.current?.querySelectorAll<HTMLElement>("[data-collection-row-id]") ?? []);
            const after = rows.slice(rows.findIndex(item => item.dataset.collectionRowId === row.id) + 1).map(item => item.dataset.collectionRowId!);
            return () => after.map(id => findPaneCollectionRowFocusTarget(paneId, id)).find(target => target !== null)
              ?? browse.current ?? card.current ?? findPaneLandmarkFocusTarget(paneId);
          },
        };
        const local = library.is_default ? null : projectPodcastLibraryRemovalAction({
          podcastId: row.id, title: row.title.text, libraryId: library.id, libraryName: library.name,
          canRemove: data?.can_add_content === true, blocked, ctx, run, focus,
        });
        const action = local ?? projectPodcastSubscriptionAction({
          target: { kind: "Canonical", podcast_id: row.id }, title: row.title.text, subscribed: true,
          disabledReason: blocked === null ? null : "checking subscription…", ctx, run, focus,
        });
        const label = local?.accessibleLabel ?? `${action.label}: ${row.title.text}`;
        const descriptionId = `${reasonId}-${row.id}`;
        return <CollectionRow {...props} compactPrimaryControl actionFocus={focus}
          occurrenceActions={local === null ? undefined : [local]}
          primaryControl={<>
            <Button iconOnly icon={action.icon} aria-label={label} aria-haspopup="dialog"
              aria-disabled={action.disabled} aria-describedby={action.disabledReason ? descriptionId : undefined}
              tooltip={{ text: action.disabledReason ? `${label}: ${action.disabledReason}` : label }}
              onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
              onClick={event => { event.stopPropagation(); const detail = prepareActionSelect(event, event.currentTarget); if (detail) action.onSelect(detail); }} />
            {action.disabledReason ? <span className="sr-only" id={descriptionId}>{action.disabledReason}</span> : null}
          </>} />;
      } : undefined}
      rowPanels={Object.fromEntries((data?.subscriptions ?? []).flatMap(show => !live || show.recurring.error_code !== null || show.recurring.had_coverage_gaps || show.imports.length > 0 ? [[show.podcast.id, <div key={show.podcast.id}>
        {show.recurring.error_code !== null || show.recurring.had_coverage_gaps ? <p>the last check could not load all available episodes.{live ? " checking will retry automatically." : null}</p> : null}
        {!live ? <p>at last catalog save</p> : null}
        {live ? show.imports.map(operation => <PodcastImportProgress key={operation.id} operation={operation} title={show.podcast.title} following={show.destinations.some(destination => destination.library_id === operation.library_id)} />) : null}
      </div>]] : []))}
      empty={source.status === "ready" && source.error === null ? <p>no subscribed podcasts.</p> : null} />
    {live && data !== null && data.imports.length > 0 ? <section aria-label="episode imports"><h3>episode imports</h3>{data.imports.map(operation => <div key={operation.id}><a href={`/podcasts/${operation.podcast_id}`}>{operation.podcast_title}</a><PodcastImportProgress operation={operation} title={operation.podcast_title} following={data.subscriptions.some(show => show.podcast.id === operation.podcast_id && show.destinations.some(destination => destination.library_id === operation.library_id))} /></div>)}</section> : null}
  </PaneSection>;
}
