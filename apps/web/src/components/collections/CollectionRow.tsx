"use client";

import { useRef, type CSSProperties, type ReactNode } from "react";
import MediaActions from "@/components/media/MediaActions";
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
  rowActionsAvailable = true,
  viewTransitionName,
}: {
  readonly row: CollectionRowView;
  readonly as?: "li" | "div";
  readonly panel?: ReactNode;
  readonly primaryControl?: ReactNode;
  readonly rowActionsAvailable?: boolean;
  readonly viewTransitionName?: string;
}) {
  const mediaLayout = row.media !== undefined;
  const paneId = usePaneRuntime()?.paneId;
  const moreRef = useRef<HTMLButtonElement>(null);
  const returnFocus = () => moreRef.current?.isConnected && moreRef.current.getClientRects().length
    ? moreRef.current : findPaneCollectionRowFocusTarget(paneId, row.id);
  const title = row.title.segments
    ? (
        <EmphasisSegments
          segments={row.title.segments}
          emphasisClassName={styles.mark}
        />
      )
    : row.title.text;

  const supporting = row.media ? <MediaIdentity subject={row.media.subject} /> : (
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
    {
      id: "View",
      actions: rowActionsAvailable && !row.resourceRef ? (row.flatActions ?? []) : [],
    },
  ];
  const more = rowActionsAvailable && row.media?.subject.kind === "External" ? (
    <ExternalMediaMenu
      subject={row.media.subject} subjectKey={`collection:${row.id}`}
      viewActions={row.resourceRef ? [] : row.flatActions ?? []}
      triggerRef={moreRef} returnFocus={returnFocus}
    />
  ) : rowActionsAvailable && (row.resourceRef || sections.some((section) => section.actions.length > 0)) ? (
    <ContextualActionMenu
      title={row.title.text} subjectKey={`collection:${row.id}`}
      sections={sections}
      resourceRef={row.resourceRef ?? undefined}
      displayedActivation={row.primary.kind === "link" ? { kind: "route", href: row.primary.href, resource_ref: row.resourceRef ?? row.id, unavailable_reason: null } : { kind: "none", href: null, resource_ref: row.resourceRef ?? row.id, unavailable_reason: null }}
      label={menuLabel}
      triggerRef={node => { moreRef.current = node; }}
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
        "data-media-identity": mediaLayout ? "true" : undefined,
        style: rootStyle,
      }}
      media={mediaLayout || row.kind === "podcast"}
      title={row.media ? <MediaTitle subject={row.media.subject} /> : title}
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
      primaryControl={mediaLayout ? undefined : primaryControl}
      actions={
        <>
          {row.media && rowActionsAvailable ? (
            <MediaActions
              subject={row.media.subject}
              knownDescriptor={row.media.knownDescriptor}
              density="Row"
              returnFocus={returnFocus}
            />
          ) : null}
          {more}
        </>
      }
      expanded={panel}
    />
  );
}
