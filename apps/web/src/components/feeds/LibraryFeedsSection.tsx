"use client";

/** Named libraries promote one scoped removal command; all, which holds only
 * subscribed sources, promotes none. Current reads gate the shortcut; canonical
 * menus prepare their own facts.
 */
import { Fact } from "@/components/feedback/Fact";
import { useId, useMemo, useRef } from "react";
import CollectionView from "@/components/collections/CollectionView";
import CollectionRow from "@/components/collections/CollectionRow";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import PaneSection from "@/components/ui/PaneSection";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { projectFeedLibraryRemovalAction } from "@/lib/actions/project";
import type { ServerValue } from "@/lib/api/serverState";
import { remoteReady } from "@/lib/native/admission";
import { presentFeed } from "@/lib/collections/presenters/feed";
import type { LibraryFeedIndex } from "@/lib/feeds/api";

import { feedBrowseAction } from "@/lib/feeds/navigation";
import type { Library } from "@/lib/libraries/api";
import { prepareActionSelect } from "@/lib/ui/actionDescriptor";
import FeedImportProgress from "./FeedImportProgress";

export default function LibraryFeedsSection({ library, source, kind }: { readonly kind: "podcast" | "article"; readonly library: Library; readonly source: ServerValue<LibraryFeedIndex> }) {
  const noun = kind === "podcast" ? "podcasts" : "feeds";
  const items = kind === "podcast" ? "episodes" : "articles";
  const browseAction = feedBrowseAction(kind);
  const { ctx, run } = useActionRuntime();
  const card = useRef<HTMLElement>(null);
  const browse = useRef<HTMLAnchorElement>(null);
  const reasonId = useId();
  const data = source.status === "ready" ? source.data : null;
  const live = source.status === "ready" && source.source.kind === "live";
  const manage = live && remoteReady();
  const blocked = !manage || source.status !== "ready" || source.error !== null || source.refreshing || !source.fresh ? "TemporarilyUnavailable" : null;
  const showsById = useMemo(() => new Map((data?.subscriptions ?? []).map(show => [show.feed.id, show])), [data]);
  const subscriptions = data?.subscriptions.filter(source => source.feed.kind === kind);
  const imports = data?.imports.filter(operation => operation.feed_kind === kind) ?? [];
  const rows = useMemo(() => (subscriptions ?? []).map(show => ({
    ...presentFeed({ kind, subtitle: null, id: show.feed.id, title: show.feed.title, imageUrl: show.feed.image_url, contributors: show.feed.contributors, recurring: live ? show.recurring : null }),
    context: live ? null : { kind: "Text" as const, text: show.recurring.error_code !== null || show.recurring.had_coverage_gaps
      ? `at last catalog save · last ${kind === "podcast" ? "episode" : "article"} check incomplete` : "at last catalog save" },
  })), [subscriptions, live, kind]);
  return <PaneSection ref={card} title={`${noun}${data === null ? "" : ` · ${subscriptions?.length ?? 0}`}`} aria-label={noun} tabIndex={-1}
    actions={<ButtonLink ref={browse} href={browseAction.href} iconOnly icon={browseAction.icon}
      aria-label={browseAction.label} tooltip={{ text: browseAction.label }} />}>
    <CollectionView geometry="UniformIndex" surface={false} returnScope={`Library.Feeds:${kind}:${library.id}`} ariaLabel={`subscribed ${noun}`} status={source.status === "failed" ? "error" : source.status}
      rows={rows}
      renderRow={manage ? props => {
        const { row } = props;
        const focus = {
          trigger: null,
          returnFocus: () => card.current?.querySelector<HTMLElement>(`[data-collection-row-id="${CSS.escape(row.id)}"] [data-row-actions-control]`)
            ?? browse.current ?? card.current,
          afterRemoval: props.afterRemoval,
        };
        const local = library.is_default ? null : projectFeedLibraryRemovalAction({
          feedId: row.id, feedKind: kind, title: row.title.text, libraryId: library.id, libraryName: library.name,
          canRemove: data?.can_add_content === true, blocked, ctx, run, focus,
        });
        const descriptionId = `${reasonId}-${row.id}`;
        const show = showsById.get(row.id);
        const attention = show?.recurring.error_code !== null && show?.recurring.error_code !== undefined || show?.recurring.had_coverage_gaps
          ? `last ${kind === "podcast" ? "episode" : "article"} check incomplete`
          : show?.imports.some(operation => operation.state === "failed") ? `${items} addition stopped`
          : show?.imports.some(operation => operation.state === "pending" || operation.state === "running") ? `adding ${items}` : undefined;
        return <CollectionRow {...props} attention={attention} compactPrimaryControl={local !== null} actionFocus={focus}
          occurrenceActions={local === null ? undefined : [local]}
          primaryControl={local === null ? undefined : <>
            <Button iconOnly icon={local.icon} aria-label={local.accessibleLabel} aria-haspopup="dialog"
              aria-disabled={local.disabled} aria-describedby={local.disabledReason ? descriptionId : undefined}
              tooltip={{ text: local.disabledReason ? `${local.accessibleLabel}: ${local.disabledReason}` : local.accessibleLabel }}
              onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
              onClick={event => { event.stopPropagation(); const detail = prepareActionSelect(event, event.currentTarget); if (detail) local.onSelect(detail); }} />
            {local.disabledReason ? <span className="sr-only" id={descriptionId}>{local.disabledReason}</span> : null}
          </>} />;
      } : undefined}
      empty={source.status === "ready" && source.error === null ? <Fact line={{ fact: `no subscribed ${noun}.` }} /> : null} />
    {live && data !== null && imports.length > 0 ? <section aria-label={`${items} additions`}><h3>{items} additions</h3>{imports.map(operation => <div key={operation.id}><a href={`/${kind === "podcast" ? "podcasts" : "feeds"}/${operation.feed_id}`}>{operation.feed_title}</a><FeedImportProgress operation={operation} title={operation.feed_title} /></div>)}</section> : null}
  </PaneSection>;
}
