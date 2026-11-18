"use client";

import { useCallback, useRef, type AnimationEventHandler, type ComponentProps, type ReactNode } from "react";
import ResourceActions from "@/components/resources/ResourceActions";
import { ResourceIndexTitle } from "@/components/resources/ResourceType";
import FeedMenu from "@/components/feeds/FeedMenu";
import ExternalMediaMenu from "@/components/media/ExternalMediaMenu";
import MediaIdentity, { MediaFacts } from "@/components/media/MediaIdentity";
import { paneForkLink } from "@/lib/panes/paneForkLink";
import { useTouchCapable } from "@/lib/renderEnvironment/provider";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { findPaneCollectionRowFocusTarget } from "@/lib/workspace/paneDom";
import IndexBibliography from "@/components/resources/IndexBibliography";
import EmphasisSegments from "@/components/ui/EmphasisSegments";
import OverflowMenuButton from "@/components/ui/OverflowMenuButton";
import ResourceRow from "@/components/ui/ResourceRow";
import ResourceCell from "@/components/ui/ResourceCell";
import Artwork, { remoteArtwork } from "@/components/ui/Artwork";
import ContextualActionMenu, { type ContextActionSection } from "@/components/resources/ContextualActionMenu";
import type { CollectionContext, CollectionRowView } from "@/lib/collections/types";
import { assertNever } from "@/lib/assertNever";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import { mediaSubjectKind } from "@/lib/media/mediaSummary";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { resourceType, resourceTypeName } from "@/lib/resources/type";
import styles from "./CollectionRow.module.css";

function renderContext(context: CollectionContext): ReactNode {
  switch (context.kind) {
    case "Snippet": return <EmphasisSegments segments={context.segments} emphasisClassName={styles.mark} />;
    case "Text": return context.text;
    default: return assertNever(context, "Unsupported collection context");
  }
}

/**
 * Collection semantics compose the shared row or cover cell. Occurrence commands
 * retain their authority; only explicitly menu-owned shortcuts demote. Attention
 * names the existing details/recovery destination on the surviving more control.
 */
export default function CollectionRow({
  row, as = "li", primaryControl, occurrenceActions, afterRemoval, rowActionsAvailable = true,
  listPosition, containingPodcastId = null, className, onAnimationEnd, layout = "Rows",
}: {
  readonly row: CollectionRowView;
  readonly as?: "li" | "div";
  readonly primaryControl?: ReactNode;
  readonly occurrenceActions?: readonly ActionDescriptor[];
  readonly afterRemoval: () => HTMLElement | null;
  readonly rowActionsAvailable?: boolean;
  readonly listPosition?: { readonly index: number; readonly count: number };
  readonly containingPodcastId?: string | null;
  readonly className?: string;
  readonly onAnimationEnd?: AnimationEventHandler<HTMLElement>;
  readonly layout?: "Rows" | "Wall";
}) {
  const parsed = row.resourceRef === null ? null : parseResourceRef(row.resourceRef);
  // justify-defect: a nonnull collection ref identifies the displayed canonical resource.
  if (row.resourceRef !== null && parsed === null) throw new Error(`Invalid canonical collection resource ref: ${row.resourceRef}`);
  const media = row.resourceActions?.kind === "Media" ? row.resourceActions : null;
  const type = media !== null ? resourceType("media", mediaSubjectKind(media.subject))
    : parsed !== null ? resourceType(parsed.scheme, null)
    : row.kind === "podcast" ? resourceType("podcast", null) : null;
  const typeLabel = type === null ? null : resourceTypeName(type);
  const podcast = row.resourceActions?.kind === "Feed" ? row.resourceActions.subject : null;
  const pane = usePaneRuntime();
  const paneId = pane?.paneId;
  const touch = useTouchCapable();
  const moreRef = useRef<HTMLButtonElement>(null);
  const primaryControlRef = useRef<HTMLSpanElement>(null);
  const setMore = useCallback((node: HTMLButtonElement | null) => { moreRef.current = node; }, []);
  const returnFocus = () => moreRef.current?.isConnected && moreRef.current.getClientRects().length
    ? moreRef.current : findPaneCollectionRowFocusTarget(paneId, row.id);
  const successFocus = podcast?.target.kind === "Discovery" ? () => null : afterRemoval;
  const actionFocus = { get trigger() { return moreRef.current; }, returnFocus, afterRemoval: successFocus };
  useActionFocusRecovery(primaryControlRef, returnFocus);
  const title = row.title.segments
    ? <EmphasisSegments segments={row.title.segments} emphasisClassName={styles.mark} /> : row.title.text;
  const primary = typeLabel !== null && row.primary.kind !== "static"
    ? { ...row.primary, label: `${typeLabel}: ${row.primary.label ?? row.title.text}` } : row.primary;
  const attention = media?.subject.kind === "Stored" && media.subject.summary.processing_status === "failed"
    ? "couldn’t process this. see its metadata." : null;
  const sections: readonly ContextActionSection[] = [
    { id: "Occurrence", actions: rowActionsAvailable ? (occurrenceActions ?? []) : [] },
  ];
  const menuAvailable = rowActionsAvailable && Boolean(row.resourceRef || podcast !== null || sections.some((section) => section.actions.length > 0));
  const menuLabel = `more actions for ${row.title.text}${attention ? `: ${attention}` : ""}`;
  const more = rowActionsAvailable && media?.subject.kind === "External" ? <ExternalMediaMenu
    subject={media.subject} subjectKey={`collection:${row.id}`}
    triggerRef={moreRef} returnFocus={returnFocus}
  /> : rowActionsAvailable && podcast !== null && row.resourceRef === null ? <FeedMenu
    subject={podcast} metadataSubject={row.podcastMetadata} subjectKey={`collection:${row.id}`} sections={sections}
    actionFocus={actionFocus} triggerRef={setMore} triggerAttributes={{ "data-row-actions-control": "" }}
    label={menuLabel}
  /> : menuAvailable ? <ContextualActionMenu
    title={row.title.text} subjectKey={`collection:${row.id}`} sections={sections}
    resourceRef={row.resourceRef ?? undefined} actionFocus={actionFocus}
    navigation={{
      key: `collection:${row.id}:${row.primary.kind === "link" ? row.primary.href : "unavailable"}`,
      fork: touch && pane && row.primary.kind === "link" && row.primary.href !== null
        ? paneForkLink({ runtime: pane, target: { href: row.primary.href, labelHint: row.primary.paneLabelHint }, disabledReason: null }) : null,
    }}
    label={menuLabel} triggerRef={setMore} triggerAttributes={{ "data-row-actions-control": "" }}
    renderTrigger={(props) => <>
      <OverflowMenuButton {...props} title={attention ? menuLabel : undefined} />
      {attention ? <span className={styles.attentionMark} aria-hidden="true">!</span> : null}
    </>}
  /> : null;
  const metadata = <span className={styles.supportLine}>
    {media ? <MediaIdentity subject={media.subject} returnFocus={returnFocus} containingPodcastId={containingPodcastId} /> : <IndexBibliography
      show={null} contributors={row.contributors} originalPublishedDate={row.publicationDate} returnFocus={returnFocus}
    />}
    {row.context !== null ? <span className={styles.context}>{renderContext(row.context)}</span> : null}
  </span>;
  let content: ComponentProps<typeof ResourceRow>["content"];
  switch (row.presentation) {
    case "Index": content = { kind: "Index", metadata, facts: media?.subject.kind === "Stored" ? <MediaFacts summary={media.subject.summary} /> : null }; break;
    case "Details": content = { kind: "Details", body: row.context ? renderContext(row.context) : null }; break;
    default: assertNever(row.presentation);
  }
  const rootProps = { className, onAnimationEnd, "aria-current": row.selected ? "true" as const : undefined,
    "aria-posinset": listPosition ? listPosition.index + 1 : undefined, "aria-setsize": listPosition?.count,
    "data-collection-row-id": row.id, "data-collection-item-kind": row.kind };
  if (layout === "Wall") {
    if (primary.kind !== "link" || primary.href === null || row.artwork === undefined)
      throw new Error("a wall cell requires a linked source with artwork");
    return <ResourceCell as={as} rootProps={rootProps}
      primary={{ href: primary.href, label: primary.label, paneLabelHint: primary.paneLabelHint }}
      cover={<Artwork title={row.title.text} source={remoteArtwork(row.artwork.imageUrl)} size="fill" />}
      title={title} metadata={metadata} controls={more} />;
  }
  return <ResourceRow
    as={as} primary={primary} selected={row.selected}
    rootProps={rootProps}
    title={type === null ? title : <ResourceIndexTitle
      type={type} hasArtwork={row.artwork !== undefined}
    >
      {row.primary.kind === "static" ? <span className={`sr-only ${styles.accessibleContext}`} dir="ltr">{typeLabel}: </span> : null}
      {title}
    </ResourceIndexTitle>}
    content={content}
    leadingVisual={row.artwork !== undefined ? <Artwork title={row.title.text} source={remoteArtwork(row.artwork.imageUrl)} size={44} /> : undefined}
    controls={<>
      {primaryControl ? <span ref={primaryControlRef} data-row-primary-control="">{primaryControl}</span> : null}
      {row.resourceActions && rowActionsAvailable ? <ResourceActions subject={row.resourceActions} density="Row" returnFocus={returnFocus} afterRemoval={successFocus} /> : null}
      {more}
    </>}
  />;
}
