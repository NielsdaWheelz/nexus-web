"use client";

import { useCallback, useRef, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import ResourceActions from "@/components/resources/ResourceActions";
import PodcastMenu from "@/components/podcasts/PodcastMenu";
import ExternalMediaMenu from "@/components/media/ExternalMediaMenu";
import MediaIdentity, { MediaTitle } from "@/components/media/MediaIdentity";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { findPaneCollectionRowFocusTarget } from "@/lib/workspace/paneDom";
import IndexBibliography from "@/components/resources/IndexBibliography";
import EmphasisSegments from "@/components/ui/EmphasisSegments";
import OverflowMenuButton from "@/components/ui/OverflowMenuButton";
import ResourceRow from "@/components/ui/ResourceRow";
import PodcastRowArtwork from "@/components/podcasts/PodcastRowArtwork";
import ContextualActionMenu, { type ContextActionSection } from "@/components/resources/ContextualActionMenu";
import type { CollectionContext, CollectionRowView } from "@/lib/collections/types";
import { collectionActivityText } from "./collectionRowFormatting";
import { assertNever } from "@/lib/assertNever";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { PodcastActionFocus } from "@/lib/actions/inlineActions";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import styles from "./CollectionRow.module.css";

function renderContext(context: CollectionContext): ReactNode {
  switch (context.kind) {
    case "Snippet": return <EmphasisSegments segments={context.segments} emphasisClassName={styles.mark} />;
    case "Text": return context.text;
    default: return assertNever(context, "Unsupported collection context");
  }
}

/**
 * Collection semantics compose the shared bounded shell. Occurrence commands
 * retain their authority; only explicitly menu-owned shortcuts demote. Attention
 * names the existing details/recovery destination on the surviving more control.
 */
export default function CollectionRow({
  row, as = "li", primaryControl, occurrenceActions, actionFocus: suppliedActionFocus, afterRemoval,
  compactPrimaryControl = false, rowActionsAvailable = true, viewTransitionName, attention: suppliedAttention,
}: {
  readonly row: CollectionRowView;
  readonly as?: "li" | "div";
  readonly primaryControl?: ReactNode;
  readonly occurrenceActions?: readonly ActionDescriptor[];
  readonly actionFocus?: PodcastActionFocus;
  readonly afterRemoval: () => HTMLElement | null;
  readonly compactPrimaryControl?: boolean;
  readonly rowActionsAvailable?: boolean;
  readonly viewTransitionName?: string;
  readonly attention?: string;
}) {
  const media = row.resourceActions?.kind === "Media" ? row.resourceActions : null;
  const podcast = row.resourceActions?.kind === "Podcast" ? row.resourceActions.subject : null;
  const paneId = usePaneRuntime()?.paneId;
  const moreRef = useRef<HTMLButtonElement>(null);
  const primaryControlRef = useRef<HTMLSpanElement>(null);
  const setMore = useCallback((node: HTMLButtonElement | null) => { moreRef.current = node; }, []);
  const returnFocus = () => moreRef.current?.isConnected && moreRef.current.getClientRects().length
    ? moreRef.current : findPaneCollectionRowFocusTarget(paneId, row.id);
  const successFocus = podcast?.target.kind === "Discovery" ? () => null : afterRemoval;
  const actionFocus = { get trigger() { return moreRef.current; }, returnFocus,
    get afterRemoval() { return suppliedActionFocus?.afterRemoval ?? successFocus; },
  };
  useActionFocusRecovery(primaryControlRef, returnFocus);
  const title = row.title.segments
    ? <EmphasisSegments segments={row.title.segments} emphasisClassName={styles.mark} /> : row.title.text;
  const activity = row.activity !== null ? collectionActivityText(row.activity) : null;
  const attention = suppliedAttention ?? (media?.subject.kind === "Stored" && media.subject.summary.processing_status === "failed"
    ? "processing failed; open metadata for details and recovery"
    : row.exceptionalStatus !== null ? "last episode check incomplete; open show details to check again"
    : row.activity?.kind === "PodcastSync" ? `${collectionActivityText(row.activity).accessible}; open show details for progress` : null);
  const sections: readonly ContextActionSection[] = [
    { id: "Occurrence", actions: rowActionsAvailable ? (occurrenceActions ?? []) : [] },
    { id: "View", actions: rowActionsAvailable && !row.resourceRef ? (row.flatActions ?? []) : [] },
  ];
  const menuAvailable = rowActionsAvailable && Boolean(row.resourceRef || podcast !== null || sections.some((section) => section.actions.length > 0));
  const menuLabel = `more actions for ${row.title.text}${attention ? `: ${attention}` : ""}`;
  const more = rowActionsAvailable && media?.subject.kind === "External" ? <ExternalMediaMenu
    subject={media.subject} subjectKey={`collection:${row.id}`}
    viewActions={row.resourceRef ? [] : row.flatActions ?? []} triggerRef={moreRef} returnFocus={returnFocus}
  /> : rowActionsAvailable && podcast !== null && row.resourceRef === null ? <PodcastMenu
    subject={podcast} metadataSubject={row.podcastMetadata} subjectKey={`collection:${row.id}`} sections={sections}
    actionFocus={actionFocus} triggerRef={setMore} triggerAttributes={{ "data-row-actions-control": "" }}
    label={menuLabel}
    renderTrigger={(props) => <span className={styles.attentionTrigger}>
      <OverflowMenuButton {...props} title={attention ? menuLabel : undefined} />
      {attention ? <span className={styles.attentionMark} aria-hidden="true">!</span> : null}
    </span>}
  /> : menuAvailable ? <ContextualActionMenu
    title={row.title.text} subjectKey={`collection:${row.id}`} sections={sections}
    resourceRef={row.resourceRef ?? undefined} actionFocus={actionFocus}
    displayedActivation={attention !== null && row.kind === "podcast" ? undefined : row.primary.kind === "link" ? { kind: "route", href: row.primary.href, resource_ref: row.resourceRef ?? row.id, unavailable_reason: null } : { kind: "none", href: null, resource_ref: row.resourceRef ?? row.id, unavailable_reason: null }}
    label={menuLabel} triggerRef={setMore} triggerAttributes={{ "data-row-actions-control": "" }}
    renderTrigger={(props) => <span className={styles.attentionTrigger}>
      <OverflowMenuButton {...props} title={attention ? menuLabel : undefined} />
      {attention ? <span className={styles.attentionMark} aria-hidden="true">!</span> : null}
    </span>}
  /> : null;
  const metadata = <span className={styles.supportLine}>
    {attention && !menuAvailable ? <span className={styles.reason}>{attention.split(";", 1)[0]}</span> : null}
    {media ? <MediaIdentity subject={media.subject} returnFocus={returnFocus} /> : <IndexBibliography
      contributors={row.contributors} originalPublishedDate={row.publicationDate} returnFocus={returnFocus}
    />}
    {row.context !== null ? <span className={styles.context}>{renderContext(row.context)}</span> : null}
    {activity && row.activity?.kind !== "PodcastSync" ? <span className={styles.activity}>
      <span aria-hidden="true">{activity.visible}</span><span className="sr-only">{activity.accessible}</span>
    </span> : null}
  </span>;
  let content: ComponentProps<typeof ResourceRow>["content"];
  switch (row.presentation) {
    case "Index": content = { kind: "Index", metadata }; break;
    case "Details": content = { kind: "Details", body: row.context ? renderContext(row.context) : null }; break;
    default: assertNever(row.presentation);
  }
  const rootStyle: CSSProperties | undefined = viewTransitionName ? { viewTransitionName } : undefined;
  return <ResourceRow
    as={as} primary={row.primary} selected={row.selected}
    rootProps={{ "aria-current": row.selected ? "true" : undefined,
      "data-collection-row-id": row.id, "data-collection-item-kind": row.kind,
      style: rootStyle }}
    title={media ? <MediaTitle subject={media.subject} /> : title}
    content={content}
    leadingVisual={row.artwork !== undefined ? <PodcastRowArtwork key={row.artwork.imageUrl} title={row.title.text} imageUrl={row.artwork.imageUrl} /> : undefined}
    controls={<>
      {primaryControl ? <span ref={primaryControlRef} className={compactPrimaryControl ? styles.compactPrimaryControl : undefined}
        data-row-primary-control="" data-row-compact-primary-control={compactPrimaryControl ? "" : undefined}>{primaryControl}</span> : null}
      {row.resourceActions && rowActionsAvailable ? <ResourceActions subject={row.resourceActions} density="Row" returnFocus={returnFocus} afterRemoval={successFocus} /> : null}
      {more}
    </>}
  />;
}
