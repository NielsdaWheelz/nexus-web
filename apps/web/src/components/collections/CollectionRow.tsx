"use client";

import { Fragment, useId, useState, type CSSProperties, type ReactNode } from "react";
import ContributorCreditList from "@/components/contributors/ContributorCreditList";
import type { SortableActivatorProps } from "@/components/sortable/SortableList";
import ActionMenu from "@/components/ui/ActionMenu";
import Pill from "@/components/ui/Pill";
import ResourceRow from "@/components/ui/ResourceRow";
import type {
  CollectionContext,
  CollectionRowView,
  EmphasisSegment,
  ExceptionalStatus,
} from "@/lib/collections/types";
import { useRelatedMedia } from "@/lib/resonance/useRelatedMedia";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import ConnectionRail from "./ConnectionRail";
import {
  collectionActivityText,
  formatCollectionPublicationDate,
} from "./collectionRowFormatting";
import styles from "./CollectionRow.module.css";

function renderSegments(segments: readonly EmphasisSegment[]): ReactNode {
  return segments.map((segment, index) =>
    segment.emphasized ? (
      <mark key={index} className={styles.mark}>
        {segment.text}
      </mark>
    ) : (
      <span key={index}>{segment.text}</span>
    ),
  );
}

function assertNever(value: never, context: string): never {
  throw new Error(`${context}: ${JSON.stringify(value)}`);
}

function renderContext(context: CollectionContext): ReactNode {
  switch (context.kind) {
    case "Snippet":
      return renderSegments(context.segments);
    case "Text":
      return context.text;
    default:
      return assertNever(context, "Unsupported collection context");
  }
}

function renderExceptionalStatus(status: ExceptionalStatus): ReactNode {
  switch (status.kind) {
    case "MediaProcessing":
      const processingStatus = status.status;
      switch (processingStatus) {
        case "pending":
          return <Pill tone="neutral">Queued</Pill>;
        case "extracting":
          return <Pill tone="info">Processing</Pill>;
        case "failed":
          return <Pill tone="danger">Processing failed</Pill>;
        default:
          return assertNever(
            processingStatus,
            "Unsupported media processing status",
          );
      }
    case "PodcastSync":
      const podcastSyncStatus = status.status;
      switch (podcastSyncStatus) {
        case "pending":
          return <Pill tone="neutral">Sync pending</Pill>;
        case "running":
          return <Pill tone="info">Syncing</Pill>;
        case "partial":
          return <Pill tone="warning">Partial sync</Pill>;
        case "source_limited":
          return <Pill tone="warning">Source-limited</Pill>;
        case "failed":
          return <Pill tone="danger">Sync failed</Pill>;
        default:
          return assertNever(
            podcastSyncStatus,
            "Unsupported podcast sync status",
          );
      }
    default:
      return assertNever(status, "Unsupported exceptional status");
  }
}

function separateActionGroup(
  existing: readonly ActionDescriptor[],
  next: readonly ActionDescriptor[],
): ActionDescriptor[] {
  if (next.length === 0) return [...existing];
  if (existing.length === 0) return [...next];
  return [...existing, { ...next[0], separatorBefore: true }, ...next.slice(1)];
}

/** Canonical semantic renderer for every media-like collection row. */
export default function CollectionRow({
  row,
  as = "li",
  panel,
  primaryControl,
  reorder,
  viewTransitionName,
}: {
  readonly row: CollectionRowView;
  readonly as?: "li" | "div";
  readonly panel?: ReactNode;
  readonly primaryControl?: ReactNode;
  readonly reorder?: SortableActivatorProps;
  readonly viewTransitionName?: string;
}) {
  const [showPeers, setShowPeers] = useState(false);
  const disclosureId = useId();
  const reorderHintId = useId();

  const connections = row.connections.kind === "Present" ? row.connections.value : null;
  const relatedMediaId =
    row.relatedMediaId.kind === "Present" ? row.relatedMediaId.value : null;
  const hasConnections = connections !== null && connections.total > 0;
  const hasPeerAffordance = hasConnections || relatedMediaId !== null;
  const related = useRelatedMedia(showPeers ? relatedMediaId : null);
  const relatedStatus =
    relatedMediaId !== null && showPeers
      ? related.loading
        ? "loading"
        : related.error
          ? "error"
          : "ready"
      : "idle";

  const title = row.title.segments
    ? renderSegments(row.title.segments)
    : row.title.text;

  const supportParts: ReactNode[] = [];
  if (row.contributors.length > 0) {
    supportParts.push(
      <ContributorCreditList
        key="contributors"
        className={styles.contributorList}
        credits={row.contributors}
        maxVisible={2}
      />,
    );
  }
  if (row.publicationDate.kind === "Present") {
    const formattedDate = formatCollectionPublicationDate(row.publicationDate.value);
    supportParts.push(
      <time key="date" dateTime={row.publicationDate.value}>
        {formattedDate}
      </time>,
    );
  }
  if (row.context.kind === "Present") {
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

  const activity =
    row.activity.kind === "Present" ? collectionActivityText(row.activity.value) : null;
  const exceptionalStatus =
    row.exceptionalStatus.kind === "Present"
      ? renderExceptionalStatus(row.exceptionalStatus.value)
      : undefined;

  let options: ActionDescriptor[] = [];
  if (reorder) {
    options = [
      {
        kind: "command",
        id: "move-up",
        label: "Move up",
        disabled: !reorder.canMoveUp,
        onSelect: reorder.moveUp,
      },
      {
        kind: "command",
        id: "move-down",
        label: "Move down",
        disabled: !reorder.canMoveDown,
        onSelect: reorder.moveDown,
      },
    ];
  }
  if (hasPeerAffordance) {
    options = separateActionGroup(options, [
      {
        kind: "command",
        id: "connections-related",
        label: "Connections and related",
        state: showPeers
          ? {
              kind: "disclosure",
              expanded: true,
              controls: disclosureId,
              menuLabels: {
                collapsed: "Show connections and related",
                expanded: "Hide connections and related",
              },
            }
          : {
              kind: "disclosure",
              expanded: false,
              menuLabels: {
                collapsed: "Show connections and related",
                expanded: "Hide connections and related",
              },
            },
        onSelect: () => setShowPeers((visible) => !visible),
      },
    ]);
  }
  options = separateActionGroup(options, row.actions);

  const actions =
    options.length > 0 ? (
      <>
        {reorder && !reorder.disabled ? (
          <span id={reorderHintId} className="sr-only">
            Drag to reorder. Use Move up or Move down in this menu, or press Alt
            plus Arrow Up or Alt plus Arrow Down.
          </span>
        ) : null}
        <ActionMenu
          options={options}
          label={`More actions for ${row.title.text}`}
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
    ) : undefined;

  const expanded =
    (showPeers && hasPeerAffordance) || panel ? (
      <>
        {showPeers && hasPeerAffordance ? (
          <div id={disclosureId}>
            <ConnectionRail
              peers={connections ? [...connections.topPeers] : []}
              related={related.data ? [...related.data] : []}
              relatedStatus={relatedStatus}
            />
          </div>
        ) : null}
        {panel}
      </>
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
        "data-collection-row-id": row.id,
        "data-collection-item-kind": row.kind,
        "data-view-transition-part": "row",
        style: rootStyle,
      }}
      title={title}
      supporting={supporting}
      activity={
        activity ? (
          <span className={styles.activity}>
            <span aria-hidden="true">{activity.visible}</span>
            <span className="sr-only">{activity.accessible}</span>
          </span>
        ) : undefined
      }
      exceptionalStatus={exceptionalStatus}
      primaryControl={primaryControl}
      actions={actions}
      expanded={expanded}
    />
  );
}
