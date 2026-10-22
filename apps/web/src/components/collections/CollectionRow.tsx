"use client";

import {
  Fragment,
  type CSSProperties,
  type ReactNode,
} from "react";
import MediaIdentity from "@/components/media/MediaIdentity";
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
  ExceptionalStatus,
} from "@/lib/collections/types";
import {
  collectionActivityText,
  collectionConsumptionText,
} from "./collectionRowFormatting";
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

function renderExceptionalStatus(status: ExceptionalStatus): ReactNode {
  switch (status.kind) {
    case "MediaProcessing":
      return <span>processing failed</span>;
    case "PodcastSync":
      const podcastSyncStatus = status.status;
      switch (podcastSyncStatus) {
        case "Failed":
          return <Pill tone="danger">Update failed</Pill>;
        default:
          return assertNever(
            podcastSyncStatus,
            "Unsupported podcast update status",
          );
      }
    default:
      return assertNever(status, "Unsupported exceptional status");
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
  const mediaLayout = row.mediaIdentity !== undefined;
  const title = row.title.segments
    ? (
        <EmphasisSegments
          segments={row.title.segments}
          emphasisClassName={styles.mark}
        />
      )
    : row.title.text;

  const supportParts: ReactNode[] = [];
  const remainingTime =
    row.activity !== null && row.activity.kind === "RemainingTime"
      ? collectionActivityText(row.activity)
      : null;
  if (row.contributors.length || row.publicationDate !== null) supportParts.push(
    <ResourceMetadata key="bibliography" parts={bibliographyMetadata(row.contributors, row.publicationDate)} linkSource={false} />,
  );
  if (row.context !== null && !mediaLayout) {
    supportParts.push(
      <span key="context" className={styles.context}>
        {renderContext(row.context)}
      </span>,
    );
  }
  const bibliography = supportParts.length > 0 ? (
      <span className={mediaLayout ? styles.bibliography : styles.supportLine}>
        {supportParts.map((part, index) => (
          <Fragment key={index}>
            {index > 0 ? (
              <span className={styles.supportSeparator}>
                <span aria-hidden="true">·</span>
                <span className="sr-only">, </span>
              </span>
            ) : null}
            <span className={styles.supportItem}>{part}</span>
          </Fragment>
        ))}
      </span>
    ) : undefined;
  const supporting = mediaLayout && (bibliography !== undefined || row.mediaIdentity === "Stored") ? (
    <span className={styles.mediaSupportLine}>
      {bibliography}
      {row.mediaIdentity === "Stored" ? (
        <span className={styles.readingFacts}>
          <span>{collectionConsumptionText(row.consumption)}</span>
          {remainingTime ? (
            <>
              <span className={styles.supportSeparator} aria-hidden="true">·</span>
              <span>
                <span aria-hidden="true" dir="auto">{remainingTime.visible}</span>
                <span className="sr-only">, {remainingTime.accessible}</span>
              </span>
            </>
          ) : null}
        </span>
      ) : null}
    </span>
  ) : bibliography;
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
      ? renderExceptionalStatus(row.exceptionalStatus)
      : undefined;
  const failed = mediaLayout && Boolean(exceptionalStatus);
  const status = exceptionalStatus || activity ? (
    <span className={failed ? `${styles.status} ${styles.failed}` : styles.status}>
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
  const actions = rowActionsAvailable &&
    (row.resourceRef || sections.some((section) => section.actions.length > 0)) ? (
    <ContextualActionMenu
      title={row.title.text} subjectKey={`collection:${row.id}`}
      sections={sections}
      resourceRef={row.resourceRef ?? undefined}
      displayedActivation={row.primary.kind === "link" ? { kind: "route", href: row.primary.href, resource_ref: row.resourceRef ?? row.id, unavailable_reason: null } : { kind: "none", href: null, resource_ref: row.resourceRef ?? row.id, unavailable_reason: null }}
      label={menuLabel}
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
      title={<MediaIdentity title={title} />}
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
      primaryControl={primaryControl}
      actions={actions}
      expanded={panel}
    />
  );
}
