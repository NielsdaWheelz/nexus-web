"use client";

import { useCallback, useRef, type CSSProperties, type ReactNode } from "react";
import ResourceActions from "@/components/resources/ResourceActions";
import PodcastMenu from "@/components/podcasts/PodcastMenu";
import ExternalMediaMenu from "@/components/media/ExternalMediaMenu";
import MediaIdentity, { MediaTitle } from "@/components/media/MediaIdentity";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { findPaneCollectionRowFocusTarget } from "@/lib/workspace/paneDom";
import ResourceMetadata from "@/components/resources/ResourceMetadata";
import { bibliographyMetadata } from "@/lib/resources/metadata";
import EmphasisSegments from "@/components/ui/EmphasisSegments";
import Pill from "@/components/ui/Pill";
import ResourceRow from "@/components/ui/ResourceRow";
import PodcastRowArtwork from "@/components/podcasts/PodcastRowArtwork";
import ContextualActionMenu, {
  type ContextActionSection,
} from "@/components/resources/ContextualActionMenu";
import type {
  CollectionContext,
  CollectionRowView,
} from "@/lib/collections/types";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { PodcastActionFocus } from "@/lib/actions/inlineActions";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import { collectionActivityText } from "./collectionRowFormatting";
import { assertNever } from "@/lib/assertNever";
import styles from "./CollectionRow.module.css";

function renderContext(context: CollectionContext): ReactNode {
  switch (context.kind) {
    case "Snippet":
      return (
        <EmphasisSegments
          segments={context.segments}
          emphasisClassName={styles.mark}
        />
      );
    case "Text":
      return context.text;
    default:
      return assertNever(context, "Unsupported collection context");
  }
}

/** Canonical semantic renderer for every media-like collection row. */
export default function CollectionRow({
  row,
  as = "li",
  panel,
  primaryControl,
  occurrenceActions,
  actionFocus: suppliedActionFocus,
  compactPrimaryControl = false,
  rowActionsAvailable = true,
  viewTransitionName,
  afterRemoval,
}: {
  readonly row: CollectionRowView;
  readonly as?: "li" | "div";
  readonly panel?: ReactNode;
  readonly primaryControl?: ReactNode;
  readonly occurrenceActions?: readonly ActionDescriptor[];
  readonly actionFocus?: PodcastActionFocus;
  readonly compactPrimaryControl?: boolean;
  readonly rowActionsAvailable?: boolean;
  readonly viewTransitionName?: string;
  readonly afterRemoval: () => HTMLElement | null;
}) {
  const media = row.resourceActions?.kind === "Media" ? row.resourceActions : null;
  const podcast = row.resourceActions?.kind === "Podcast" ? row.resourceActions.subject : null;
  const mediaLayout = media !== null;
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
    ? (
        <EmphasisSegments
          segments={row.title.segments}
          emphasisClassName={styles.mark}
        />
      )
    : row.title.text;

  const supporting = media ? <MediaIdentity subject={media.subject} /> : (
    <span className={styles.supportLine}>
      <ResourceMetadata parts={bibliographyMetadata(row.contributors, row.publicationDate)} linkSource={false} />
      {row.context !== null && (row.contributors.length > 0 || row.publicationDate !== null) ? <span className={styles.supportSeparator} aria-hidden="true">·</span> : null}
      {row.context !== null ? <span className={styles.context}>{renderContext(row.context)}</span> : null}
    </span>
  );
  const evidence =
    mediaLayout && row.context !== null
      ? <span className={styles.context}>{renderContext(row.context)}</span>
      : undefined;

  const activity =
    row.activity !== null && row.activity.kind !== "RemainingTime"
      ? collectionActivityText(row.activity)
      : null;
  const exceptionalStatus =
    row.exceptionalStatus !== null
      ? <Pill tone="danger">last check incomplete</Pill>
      : undefined;
  const status = exceptionalStatus || activity ? (
    <span className={styles.status}>
      {exceptionalStatus}
      {activity ? (
        <span className={styles.activity}>
          <span aria-hidden="true">{activity.visible}</span>
          <span className="sr-only">{activity.accessible}</span>
        </span>
      ) : null}
    </span>
  ) : undefined;

  const menuLabel = `more actions for ${row.title.text}`;
  const sections: readonly ContextActionSection[] = [
    { id: "Occurrence", actions: rowActionsAvailable ? occurrenceActions ?? [] : [] },
    {
      id: "View",
      actions: rowActionsAvailable && !row.resourceRef ? (row.flatActions ?? []) : [],
    },
  ];
  const more = rowActionsAvailable && media?.subject.kind === "External" ? (
    <ExternalMediaMenu
      subject={media.subject} subjectKey={`collection:${row.id}`}
      viewActions={row.resourceRef ? [] : row.flatActions ?? []}
      triggerRef={moreRef} returnFocus={returnFocus}
    />
  ) : rowActionsAvailable && podcast !== null && row.resourceRef === null ? (
    <PodcastMenu subject={podcast} subjectKey={`collection:${row.id}`} sections={sections}
      actionFocus={actionFocus} triggerRef={setMore} triggerAttributes={{ "data-row-actions-control": "" }} />
  ) : rowActionsAvailable && (row.resourceRef || sections.some((section) => section.actions.length > 0)) ? (
    <ContextualActionMenu
      title={row.title.text} subjectKey={`collection:${row.id}`}
      sections={sections}
      resourceRef={row.resourceRef ?? undefined}
      actionFocus={actionFocus}
      displayedActivation={row.primary.kind === "link" ? { kind: "route", href: row.primary.href, resource_ref: row.resourceRef ?? row.id, unavailable_reason: null } : { kind: "none", href: null, resource_ref: row.resourceRef ?? row.id, unavailable_reason: null }}
      label={menuLabel}
      triggerRef={setMore}
      triggerAttributes={{ "data-row-actions-control": "" }}
    />
  ) : undefined;

  const rootStyle: CSSProperties | undefined = viewTransitionName
    ? { viewTransitionName }
    : undefined;

  return (
    <ResourceRow
      as={as}
      primary={row.primary}
      selected={row.selected}
      rootProps={{
        "aria-current": row.selected ? "true" : undefined,
        "data-collection-row-id": row.id,
        "data-collection-item-kind": row.kind,
        style: rootStyle,
      }}
      media={mediaLayout || row.kind === "podcast"}
      title={media ? <MediaTitle subject={media.subject} /> : title}
      supporting={supporting}
      status={status}
      wrapped={mediaLayout}
      evidence={evidence}
      leadingVisual={row.artwork !== undefined ? (
        <PodcastRowArtwork
          key={row.artwork.imageUrl}
          title={row.title.text}
          imageUrl={row.artwork.imageUrl}
        />
      ) : undefined}
      primaryControl={mediaLayout ? undefined : compactPrimaryControl && primaryControl ? (
        <span ref={primaryControlRef} className={styles.compactPrimaryControl} data-row-compact-primary-control="">{primaryControl}</span>
      ) : primaryControl}
      actions={
        <>
          {row.resourceActions && rowActionsAvailable ? <ResourceActions subject={row.resourceActions}
            density="Row" returnFocus={returnFocus} afterRemoval={successFocus} /> : null}
          {more}
        </>
      }
      expanded={panel}
    />
  );
}
