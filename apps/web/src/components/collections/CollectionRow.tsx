"use client";

import {
  Fragment,
  useId,
  type CSSProperties,
  type ReactNode,
} from "react";
import { CheckCircle2 } from "lucide-react";
import ContributorCreditList from "@/components/contributors/ContributorCreditList";
import type { SortableActivatorProps } from "@/components/sortable/SortableList";
import EmphasisSegments from "@/components/ui/EmphasisSegments";
import Pill from "@/components/ui/Pill";
import ResourceRow from "@/components/ui/ResourceRow";
import ContextualActionMenu, {
  type ContextActionSection,
} from "@/components/resources/ContextualActionMenu";
import type {
  CollectionContext,
  CollectionRowView,
  ExceptionalStatus,
} from "@/lib/collections/types";
import type { LocalAvailability } from "@/lib/offlineMedia/contract";
import { formatByteCount } from "@/lib/text/formatByteCount";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import {
  collectionActivityText,
  formatCollectionPublicationDate,
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

function localAvailabilityStatus(
  availability: LocalAvailability,
): { readonly visible: string; readonly accessible: string } | null {
  switch (availability.kind) {
    case "Resolving":
      return {
        visible: "Preparing download…",
        accessible: "Preparing episode download",
      };
    case "Queued":
      switch (availability.reason) {
        case "Capacity":
          return {
            visible: "Download queued",
            accessible: "Episode download queued",
          };
        case "WaitingForNetwork":
          return {
            visible: "Waiting for network",
            accessible: "Episode download waiting for network",
          };
        case "WaitingForUnmetered":
          return {
            visible: "Waiting for Wi-Fi",
            accessible: "Episode download waiting for Wi-Fi",
          };
        case "SystemLimit":
          return {
            visible: "Download paused by Android",
            accessible: "Episode download paused by Android",
          };
      }
    case "Downloading": {
      const visible =
        availability.totalBytes.kind === "Present" &&
        availability.totalBytes.value > 0
          ? `Downloading · ${Math.floor(
              (Math.min(
                availability.bytesDownloaded,
                availability.totalBytes.value,
              ) /
                availability.totalBytes.value) *
                100,
            )}%`
          : `Downloading · ${formatByteCount(availability.bytesDownloaded)}`;
      return { visible, accessible: "Downloading episode" };
    }
    case "Restarting":
      return {
        visible: "Restarting download…",
        accessible: "Restarting episode download",
      };
    case "Ready":
      return null;
    case "Failed":
      return {
        visible: "Download failed",
        accessible: "Episode download failed",
      };
    case "Removing":
      return {
        visible: "Removing download…",
        accessible: "Removing episode download",
      };
  }
}

function RowContextualMenu({
  sections,
  actionSubject,
  label,
  reorder,
  reorderHintId,
}: {
  readonly sections: readonly ContextActionSection[];
  readonly actionSubject: CollectionRowView["actionSubject"];
  readonly label: string;
  readonly reorder?: SortableActivatorProps;
  readonly reorderHintId: string;
}) {
  if (!actionSubject && sections.every((section) => section.actions.length === 0)) {
    return null;
  }
  return (
    <>
      {reorder && !reorder.disabled ? (
        <span id={reorderHintId} className="sr-only">
          Drag to reorder. Use Move up or Move down in this menu, or press Alt
          plus Arrow Up or Alt plus Arrow Down.
        </span>
      ) : null}
      <ContextualActionMenu
        sections={sections}
        actionSubject={actionSubject ?? undefined}
        label={label}
        triggerRef={reorder?.setActivatorNodeRef}
        renderTrigger={
          reorder
            ? (triggerProps) => (
                <button
                  {...triggerProps}
                  aria-describedby={reorder.disabled ? undefined : reorderHintId}
                  aria-keyshortcuts={
                    reorder.disabled
                      ? undefined
                      : "Alt+ArrowUp Alt+ArrowDown"
                  }
                  data-sortable-activator="true"
                  onMouseDown={
                    reorder.disabled ? undefined : reorder.listeners.onMouseDown
                  }
                  onTouchStart={
                    reorder.disabled ? undefined : reorder.listeners.onTouchStart
                  }
                  onClick={(event) => {
                    if (reorder.consumeClickSuppression()) {
                      event.preventDefault();
                      event.stopPropagation();
                      return;
                    }
                    triggerProps.onClick(event);
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.altKey &&
                      !event.ctrlKey &&
                      !event.metaKey &&
                      (event.key === "ArrowUp" || event.key === "ArrowDown")
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      if (event.key === "ArrowUp" && reorder.canMoveUp) {
                        reorder.moveUp();
                      }
                      if (event.key === "ArrowDown" && reorder.canMoveDown) {
                        reorder.moveDown();
                      }
                      return;
                    }
                    triggerProps.onKeyDown(event);
                  }}
                >
                  &hellip;
                </button>
              )
            : undefined
        }
      />
    </>
  );
}

/** Canonical semantic renderer for every media-like collection row. */
export default function CollectionRow({
  row,
  as = "li",
  panel,
  primaryControl,
  reorder,
  rowActionsAvailable = true,
  viewTransitionName,
}: {
  readonly row: CollectionRowView;
  readonly as?: "li" | "div";
  readonly panel?: ReactNode;
  readonly primaryControl?: ReactNode;
  readonly reorder?: SortableActivatorProps;
  readonly rowActionsAvailable?: boolean;
  readonly viewTransitionName?: string;
}) {
  const reorderHintId = useId();

  const title = row.title.segments
    ? (
        <EmphasisSegments
          segments={row.title.segments}
          emphasisClassName={styles.mark}
        />
      )
    : row.title.text;

  const supportParts: ReactNode[] = [];
  const mediaDuration =
    row.activity.kind === "Present" && row.activity.value.kind === "MediaDuration"
      ? collectionActivityText(row.activity.value)
      : null;
  const date = row.publicationDate.kind === "Present" ? (
    <time key="date" dateTime={row.publicationDate.value}>
      {formatCollectionPublicationDate(row.publicationDate.value)}
    </time>
  ) : null;
  const contributors = row.contributors.length > 0 ? (
    <ContributorCreditList
      key="contributors"
      className={styles.contributorList}
      credits={row.contributors}
      maxVisible={2}
      overflowNoun={row.mediaIdentity ? "authors" : "contributors"}
    />
  ) : null;
  if (row.mediaIdentity) {
    if (date) supportParts.push(date);
    if (contributors) supportParts.push(contributors);
  } else {
    if (contributors) supportParts.push(contributors);
    if (date) supportParts.push(date);
  }
  if (mediaDuration) {
    supportParts.push(
      <span key="duration" className={styles.duration}>
        <span aria-hidden="true">{mediaDuration.visible}</span>
        <span className="sr-only">{mediaDuration.accessible}</span>
      </span>,
    );
  }
  if (row.context.kind === "Present" && !row.mediaIdentity) {
    supportParts.push(
      <span key="context" className={styles.context}>
        {renderContext(row.context.value)}
      </span>,
    );
  }
  const supporting =
    supportParts.length > 0 ? (
      <span className={styles.supportLine}>
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
  const evidence =
    row.mediaIdentity && row.context.kind === "Present"
      ? <span className={styles.context}>{renderContext(row.context.value)}</span>
      : undefined;

  const activity =
    row.activity.kind === "Present" && !mediaDuration
      ? collectionActivityText(row.activity.value)
      : null;
  const exceptionalStatus =
    row.exceptionalStatus.kind === "Present"
      ? renderExceptionalStatus(row.exceptionalStatus.value)
      : undefined;
  const offlineStatus =
    row.localAvailability.kind === "Present"
      ? localAvailabilityStatus(row.localAvailability.value)
      : null;
  const downloaded =
    row.localAvailability.kind === "Present" &&
    row.localAvailability.value.kind === "Ready";
  const baseStatus = offlineStatus ? (
    <span
      className={styles.activity}
    >
      <span aria-hidden="true">{offlineStatus.visible}</span>
      <span className="sr-only">{offlineStatus.accessible}</span>
    </span>
  ) : (
    (exceptionalStatus ??
      (activity ? (
        <span className={styles.activity}>
          <span aria-hidden="true">{activity.visible}</span>
          <span className="sr-only">{activity.accessible}</span>
        </span>
      ) : undefined))
  );
  const status =
    baseStatus || downloaded ? (
      <span className={styles.status}>
        {baseStatus}
        {downloaded ? (
          <span
            className={styles.downloaded}
            title="Downloaded for offline"
          >
            <CheckCircle2 size={15} aria-hidden="true" />
            <span className="sr-only">Downloaded for offline</span>
          </span>
        ) : null}
      </span>
    ) : undefined;

  const menuLabel = `${row.mediaIdentity ? "more" : "More"} actions for ${row.title.text}`;
  const occurrenceActions: ActionDescriptor[] = [];
  if (rowActionsAvailable && reorder) {
    occurrenceActions.push(
      {
        kind: "command",
        id: "ViewAction.Collection.MoveUp",
        label: "Move up",
        disabled: !reorder.canMoveUp,
        disabledReason: !reorder.canMoveUp
          ? "This item is already first"
          : undefined,
        onSelect: reorder.moveUp,
      },
      {
        kind: "command",
        id: "ViewAction.Collection.MoveDown",
        label: "Move down",
        disabled: !reorder.canMoveDown,
        disabledReason: !reorder.canMoveDown
          ? "This item is already last"
          : undefined,
        onSelect: reorder.moveDown,
      },
    );
  }
  const sections: readonly ContextActionSection[] = [
    { id: "Occurrence", actions: occurrenceActions },
    {
      id: "View",
      actions:
        rowActionsAvailable && !row.actionSubject ? (row.flatActions ?? []) : [],
    },
  ];
  const actions = rowActionsAvailable ? (
    <RowContextualMenu
      sections={sections}
      actionSubject={row.actionSubject}
      label={menuLabel}
      reorder={reorder}
      reorderHintId={reorderHintId}
    />
  ) : undefined;

  const rootStyle: CSSProperties | undefined = viewTransitionName
    ? { viewTransitionName }
    : undefined;

  return (
    <ResourceRow
      as={as}
      primary={row.primary}
      selected={row.selected || reorder?.isDragging}
      rootProps={{
        "aria-current": row.selected ? "true" : undefined,
        "data-collection-row-id": row.id,
        "data-collection-item-kind": row.kind,
        "data-media-identity": row.mediaIdentity ? "true" : undefined,
        "data-media-failed": row.mediaIdentity && exceptionalStatus ? "true" : undefined,
        "data-view-transition-part": "row",
        style: rootStyle,
      }}
      title={title}
      supporting={supporting}
      status={status}
      separateStatus={!row.mediaIdentity}
      evidence={evidence}
      primaryControl={primaryControl}
      actions={actions}
      expanded={panel}
    />
  );
}
