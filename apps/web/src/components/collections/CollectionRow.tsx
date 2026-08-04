"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { CheckCircle2, Waypoints } from "lucide-react";
import ContributorCreditList from "@/components/contributors/ContributorCreditList";
import type { SortableActivatorProps } from "@/components/sortable/SortableList";
import ActionMenu from "@/components/ui/ActionMenu";
import EmphasisSegments from "@/components/ui/EmphasisSegments";
import Pill from "@/components/ui/Pill";
import ResourceRow from "@/components/ui/ResourceRow";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import type {
  CollectionContext,
  CollectionRowView,
  ExceptionalStatus,
} from "@/lib/collections/types";
import type { LocalAvailability } from "@/lib/offlineMedia/contract";
import { useRelatedMedia } from "@/lib/resonance/useRelatedMedia";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { useOptionalMobileChromeVisibleLocks } from "@/lib/workspace/mobileChrome";
import ConnectionRail from "./ConnectionRail";
import {
  collectionActivityText,
  formatCollectionPublicationDate,
} from "./collectionRowFormatting";
import styles from "./CollectionRow.module.css";

function assertNever(value: never, context: string): never {
  throw new Error(`${context}: ${JSON.stringify(value)}`);
}

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
      const processingStatus = status.status;
      switch (processingStatus) {
        case "pending":
          return <Pill tone="neutral">Queued</Pill>;
        case "extracting":
          return <Pill tone="info">Processing</Pill>;
        case "failed":
          return <Pill tone="danger">Processing failed</Pill>;
        case "suspended":
          return <Pill tone="warning">Processing paused</Pill>;
        default:
          return assertNever(
            processingStatus,
            "Unsupported media processing status",
          );
      }
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

function formatByteCount(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1_000;
  let unit: (typeof units)[number] = units[0];
  for (const nextUnit of units.slice(1)) {
    if (value < 1_000) break;
    value /= 1_000;
    unit = nextUnit;
  }
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value)} ${unit}`;
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

function RowActionMenu({
  options,
  label,
  reorder,
  reorderHintId,
}: {
  readonly options: readonly ActionDescriptor[];
  readonly label: string;
  readonly reorder?: SortableActivatorProps;
  readonly reorderHintId: string;
}) {
  const { acquire } = useOptionalMobileChromeVisibleLocks();
  const releaseMenuLockRef = useRef<(() => void) | null>(null);
  const releaseMenuLock = useCallback(() => {
    releaseMenuLockRef.current?.();
    releaseMenuLockRef.current = null;
  }, []);
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        releaseMenuLock();
        return;
      }
      if (releaseMenuLockRef.current) return;
      releaseMenuLockRef.current = acquire("action-menu");
    },
    [acquire, releaseMenuLock],
  );
  useEffect(() => releaseMenuLock, [releaseMenuLock]);

  if (options.length === 0) return null;
  return (
    <>
      {reorder && !reorder.disabled ? (
        <span id={reorderHintId} className="sr-only">
          Drag to reorder. Use Move up or Move down in this menu, or press Alt
          plus Arrow Up or Alt plus Arrow Down.
        </span>
      ) : null}
      <ActionMenu
        options={options}
        label={label}
        onOpenChange={handleOpenChange}
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

/**
 * The list reorder handle. It is a SEPARATE control from the resource menu (AC4:
 * reorder is not a resource action). It reuses RowActionMenu so the drag
 * activator, Alt+Arrow keyboard reorder, and the Move up / Move down affordances
 * for pointer/keyboard users all live together — never merged into the resource
 * dropdown.
 */
function RowReorderControl({
  reorder,
  reorderHintId,
  title,
}: {
  readonly reorder: SortableActivatorProps;
  readonly reorderHintId: string;
  readonly title: string;
}) {
  const options: ActionDescriptor[] = [
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
  ];
  return (
    <RowActionMenu
      options={options}
      label={`Reorder ${title}`}
      reorder={reorder}
      reorderHintId={reorderHintId}
    />
  );
}

/**
 * The "Connections and related" disclosure. It is a SEPARATE row control (a
 * companion/inspector toggle), never a resource-menu item (AC4).
 */
function RowRelatedToggle({
  expanded,
  controls,
  title,
  onToggle,
}: {
  readonly expanded: boolean;
  readonly controls: string;
  readonly title: string;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.relatedToggle}
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
      aria-label={
        expanded
          ? `Hide connections and related for ${title}`
          : `Show connections and related for ${title}`
      }
      onClick={onToggle}
    >
      <Waypoints size={16} aria-hidden="true" />
    </button>
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
    ? (
        <EmphasisSegments
          segments={row.title.segments}
          emphasisClassName={styles.mark}
        />
      )
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

  // The three row controls are SEPARATE affordances (AC4): reorder and the
  // connections disclosure never live inside the resource dropdown. The resource
  // dropdown is the one canonical `ResourceActionMenu` keyed only by the row's
  // resource target; non-resource rows fall back to a plain flat menu (settings)
  // or no menu at all (external links).
  const menuLabel = `More actions for ${row.title.text}`;
  const reorderControl =
    rowActionsAvailable && reorder ? (
      <RowReorderControl
        reorder={reorder}
        reorderHintId={reorderHintId}
        title={row.title.text}
      />
    ) : null;
  const relatedControl =
    rowActionsAvailable && hasPeerAffordance ? (
      <RowRelatedToggle
        expanded={showPeers}
        controls={disclosureId}
        title={row.title.text}
        onToggle={() => setShowPeers((visible) => !visible)}
      />
    ) : null;
  let resourceMenu: ReactNode = null;
  if (rowActionsAvailable) {
    if (row.resourceTarget) {
      resourceMenu = (
        <ResourceActionMenu target={row.resourceTarget} label={menuLabel} />
      );
    } else if (row.flatActions && row.flatActions.length > 0) {
      resourceMenu = (
        <RowActionMenu
          options={row.flatActions}
          label={menuLabel}
          reorderHintId={reorderHintId}
        />
      );
    }
  }
  const actions =
    reorderControl || relatedControl || resourceMenu ? (
      <span className={styles.rowControls}>
        {reorderControl}
        {relatedControl}
        {resourceMenu}
      </span>
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
        "aria-current": row.selected ? "true" : undefined,
        "data-collection-row-id": row.id,
        "data-collection-item-kind": row.kind,
        "data-view-transition-part": "row",
        style: rootStyle,
      }}
      title={title}
      supporting={supporting}
      status={status}
      primaryControl={primaryControl}
      actions={actions}
      expanded={expanded}
    />
  );
}
