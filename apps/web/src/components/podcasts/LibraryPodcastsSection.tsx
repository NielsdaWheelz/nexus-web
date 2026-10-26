"use client";

/** Library sections promote one removal command: global in all, scoped in named
 * libraries. Current reads gate shortcuts; canonical menus prepare their own facts.
 */
import { useId, useMemo, useRef } from "react";
import CollectionView from "@/components/collections/CollectionView";
import CollectionRow from "@/components/collections/CollectionRow";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import PaneSection from "@/components/ui/PaneSection";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { projectPodcastLibraryRemovalAction, projectPodcastSubscriptionAction } from "@/lib/actions/project";
import type { ServerValue } from "@/lib/api/serverState";
import { remoteReady } from "@/lib/native/admission";
import { presentPodcast } from "@/lib/collections/presenters/podcast";
import type { LibraryPodcastIndex } from "@/lib/podcasts/api";
import { PODCAST_BROWSE_ACTION } from "@/lib/podcasts/navigation";
import { usePaneIsVisible } from "@/lib/panes/paneRuntime";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import type { Library } from "@/lib/libraries/api";
import { prepareActionSelect } from "@/lib/ui/actionDescriptor";
import PodcastImportProgress from "./PodcastImportProgress";

export default function LibraryPodcastsSection({ library, active, source }: { readonly library: Library; readonly active: boolean; readonly source: ServerValue<LibraryPodcastIndex> }) {
  const { ctx, run } = useActionRuntime();
  const card = useRef<HTMLElement>(null);
  const browse = useRef<HTMLAnchorElement>(null);
  const reasonId = useId();
  const visible = usePaneIsVisible();
  const data = source.status === "ready" ? source.data : null;
  const live = source.status === "ready" && source.source.kind === "live";
  const manage = live && remoteReady();
  const blocked = !manage || source.status !== "ready" || source.error !== null || source.refreshing || !source.fresh ? "TemporarilyUnavailable" : null;
  const busy = data !== null && (data.imports.some(operation => operation.state === "pending" || operation.state === "running") || data.subscriptions.some(show => show.recurring.state !== "idle" || show.imports.some(operation => operation.state === "pending" || operation.state === "running")));
  // justify-polling: imports and recurring publication have no client event stream.
  useIntervalPoll({ enabled: manage && active && visible && busy, pollIntervalMs: 3000, onPoll: () => {
    if (document.visibilityState === "visible") source.revalidate();
  } });
  const showsById = useMemo(() => new Map((data?.subscriptions ?? []).map(show => [show.podcast.id, show])), [data]);
  const subscriptions = data?.subscriptions;
  const rows = useMemo(() => (subscriptions ?? []).map(show => ({
    ...presentPodcast({ facts: null, id: show.podcast.id, title: show.podcast.title, imageUrl: show.podcast.image_url, contributors: show.podcast.contributors, unplayedCount: null, recurring: live ? show.recurring : null }),
    context: live ? null : { kind: "Text" as const, text: show.recurring.error_code !== null || show.recurring.had_coverage_gaps
      ? "at last catalog save · last episode check incomplete" : "at last catalog save" },
  })), [subscriptions, live]);
  return <PaneSection ref={card} title={`podcasts${data === null ? "" : ` · ${data.subscriptions.length}`}`} aria-label="podcasts" tabIndex={-1}
    actions={<ButtonLink ref={browse} href={PODCAST_BROWSE_ACTION.href} iconOnly icon={PODCAST_BROWSE_ACTION.icon}
      aria-label={PODCAST_BROWSE_ACTION.label} tooltip={{ text: PODCAST_BROWSE_ACTION.label }} />}>
    <CollectionView geometry="UniformIndex" surface={false} returnScope={`Library.Podcasts:${library.id}`} ariaLabel="subscribed podcasts" status={source.status === "failed" ? "error" : source.status}
      rows={rows}
      renderRow={manage ? props => {
        const { row } = props;
        const focus = {
          trigger: null,
          returnFocus: () => card.current?.querySelector<HTMLElement>(`[data-collection-row-id="${CSS.escape(row.id)}"] [data-row-actions-control]`)
            ?? browse.current ?? card.current,
          afterRemoval: props.afterRemoval,
        };
        const local = library.is_default ? null : projectPodcastLibraryRemovalAction({
          podcastId: row.id, title: row.title.text, libraryId: library.id, libraryName: library.name,
          canRemove: data?.can_add_content === true, blocked, ctx, run, focus,
        });
        const action = local ?? projectPodcastSubscriptionAction({
          target: { kind: "Canonical", podcast_id: row.id }, title: row.title.text,
          facts: source.status === "ready" && source.error !== null
            ? { kind: "Failed", observedSubscribed: true, error: source.error, retry: source.refetch, retrying: source.refreshing }
            : blocked !== null ? { kind: "Resolving", observedSubscribed: true }
            : { kind: "Ready", resolution: { kind: "Canonical", podcast_id: row.id, subscribed: true } },
          disabledReason: null, ctx, run, focus,
        });
        const label = action.accessibleLabel;
        const descriptionId = `${reasonId}-${row.id}`;
        const show = showsById.get(row.id);
        const attention = show?.recurring.error_code !== null && show?.recurring.error_code !== undefined || show?.recurring.had_coverage_gaps
          ? "last episode check incomplete; open show details to check again"
          : show?.imports.some(operation => operation.state === "failed") ? "episode import paused; open show details to retry"
          : show?.imports.some(operation => operation.state === "pending" || operation.state === "running") ? "importing episodes; open show details for progress" : undefined;
        return <CollectionRow {...props} attention={attention} compactPrimaryControl actionFocus={focus}
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
      empty={source.status === "ready" && source.error === null ? <p>no subscribed podcasts.</p> : null} />
    {live && data !== null && data.imports.length > 0 ? <section aria-label="episode additions"><h3>episode additions</h3>{data.imports.map(operation => <div key={operation.id}><a href={`/podcasts/${operation.podcast_id}`}>{operation.podcast_title}</a><PodcastImportProgress operation={operation} title={operation.podcast_title} /></div>)}</section> : null}
  </PaneSection>;
}
