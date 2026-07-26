"use client";

import {
  Fragment,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import ContributorCreditList from "@/components/contributors/ContributorCreditList";
import {
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { present } from "@/lib/api/presence";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { toFeedback, useFeedback } from "@/components/feedback/Feedback";
import type { SortableActivatorProps } from "@/components/sortable/SortableList";
import ActionMenu from "@/components/ui/ActionMenu";
import Pill from "@/components/ui/Pill";
import ResourceRow from "@/components/ui/ResourceRow";
import {
  composeResourceMenu,
  RESOURCE_ACTION_CATALOG,
  resolveResourceCoreActions,
  resolveUniversalResourceRelationshipActions,
  type ActionPublication,
  type ResourceActionId,
} from "@/lib/actions/resourceActions";
import type {
  CollectionContext,
  CollectionRowView,
  EmphasisSegment,
  ExceptionalStatus,
} from "@/lib/collections/types";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import {
  executeResourceChat,
  executeResourceLibraryPlacement,
  executeResourceOpen,
  executeResourceShare,
} from "@/lib/resources/resourceActionExecution";
import { useRelatedMedia } from "@/lib/resonance/useRelatedMedia";
import { useLibraryPlacementController } from "@/lib/libraries/placementController";
import { useShareController } from "@/lib/sharing/controller";
import { paneShareOpenOptions } from "@/lib/sharing/openOptions";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { findPaneChromeFocusTarget } from "@/lib/workspace/paneDom";
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

const EMPTY_BUSY_IDS: ReadonlySet<ResourceActionId> = new Set();

function ResourceCollectionRowActionMenu({
  publication,
  rendererView,
  label,
  title,
  reorder,
  reorderHintId,
}: {
  readonly publication: Extract<ActionPublication, { kind: "ResourceMenu" }>;
  readonly rendererView: readonly ActionDescriptor[];
  readonly label: string;
  readonly title: string;
  readonly reorder?: SortableActivatorProps;
  readonly reorderHintId: string;
}) {
  const paneRuntime = usePaneRuntime();
  const { openLibraryPlacement } = useLibraryPlacementController();
  const { openShare } = useShareController();
  const feedback = useFeedback();
  const busyIdsRef = useRef<ReadonlySet<ResourceActionId>>(EMPTY_BUSY_IDS);
  const [busyIds, setBusyIds] =
    useState<ReadonlySet<ResourceActionId>>(EMPTY_BUSY_IDS);

  if (publication.groups.core.length > 0) {
    // justify-defect: CollectionRow is the sole universal-core owner at this
    // boundary; accepting published core would create a second policy path.
    throw new Error("Collection resource publications must not publish core actions");
  }

  const requirePaneRuntime = () => {
    if (paneRuntime === null) {
      // justify-defect: standing collection actions execute only inside a pane;
      // no alternate navigation contract exists at this surface.
      throw new Error("Collection resource action requires pane runtime");
    }
    return paneRuntime;
  };

  const openResource = (
    target: Extract<typeof publication.target, { kind: "Resource" }>,
  ) => {
    const runtime = requirePaneRuntime();
    executeResourceOpen({
      target,
      resourceNavigation: {
        labelHint: title,
        navigate: (href) => runtime.router.push(href, { labelHint: title }),
        openInNewPane: runtime.openInNewPane,
      },
    });
  };
  const groups =
    publication.target.kind === "External"
      ? resolveResourceCoreActions({
          target: publication.target,
          projection: "Representation",
        })
      : resolveResourceCoreActions({
          target: publication.target,
          projection: "Representation",
          busyIds,
          executors: {
            open: openResource,
            share: (subject, detail) => {
              const runtime = requirePaneRuntime();
              executeResourceShare({
                subject,
                openShare,
                options: paneShareOpenOptions(detail.triggerEl, runtime.paneId),
              });
            },
            chat: async (subject) => {
              const actionId = RESOURCE_ACTION_CATALOG.Chat.id;
              if (busyIdsRef.current.has(actionId)) return;
              const nextBusyIds = new Set(busyIdsRef.current).add(actionId);
              busyIdsRef.current = nextBusyIds;
              setBusyIds(nextBusyIds);
              try {
                const runtime = requirePaneRuntime();
                await executeResourceChat({
                  ref: subject.ref,
                  openConversation: (conversationId) =>
                    runtime.openInNewPane(
                      `/conversations/${conversationId}`,
                      "Chat",
                    ),
                });
              } catch (error) {
                if (handleUnauthenticatedApiError(error)) return;
                if (!isApiError(error) || isSameSystemApiDefect(error)) {
                  throw error;
                }
                feedback.show(
                  toFeedback(error, {
                    fallback: "Failed to start resource chat",
                  }),
                );
              } finally {
                const remainingBusyIds = new Set(busyIdsRef.current);
                remainingBusyIds.delete(actionId);
                busyIdsRef.current = remainingBusyIds;
                setBusyIds(remainingBusyIds);
              }
            },
          },
        });

  const universalRelationships =
    publication.target.kind === "Resource"
      ? resolveUniversalResourceRelationshipActions({
          target: publication.target,
          executors: {
            libraryPlacement: (subject, detail) => {
              const runtime = requirePaneRuntime();
              executeResourceLibraryPlacement({
                subject,
                openLibraryPlacement,
                options: {
                  returnFocusTo: () => detail.triggerEl,
                  returnFocusFallback: present(() =>
                    findPaneChromeFocusTarget(runtime.paneId),
                  ),
                },
              });
            },
          },
        }).relationships
      : [];
  const options = composeResourceMenu({
    core: groups.core,
    operations: publication.groups.operations,
    relationships: [
      ...universalRelationships,
      ...publication.groups.relationships,
    ],
    view: [...publication.groups.view, ...rendererView],
  });

  return (
    <RowActionMenu
      options={options}
      label={label}
      reorder={reorder}
      reorderHintId={reorderHintId}
    />
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

  const rendererView: ActionDescriptor[] = [];
  if (reorder) {
    rendererView.push(
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
  if (hasPeerAffordance) {
    rendererView.push(
      {
        kind: "command",
        id: "ViewAction.Collection.Related",
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
    );
  }

  let actions: ReactNode;
  const menuLabel = `More actions for ${row.title.text}`;
  if (!rowActionsAvailable) {
    actions = undefined;
  } else if (row.actionPublication.kind === "ResourceMenu") {
    actions = (
      <ResourceCollectionRowActionMenu
        publication={row.actionPublication}
        rendererView={rendererView}
        label={menuLabel}
        title={row.title.text}
        reorder={reorder}
        reorderHintId={reorderHintId}
      />
    );
  } else {
    if (rendererView.length > 0) {
      // justify-defect: renderer-owned resource view actions require the
      // enforcing resource composer; a FlatMenu target cannot represent them.
      throw new Error("Flat collection menus cannot publish resource view actions");
    }
    actions = (
      <RowActionMenu
        options={row.actionPublication.actions}
        label={menuLabel}
        reorder={reorder}
        reorderHintId={reorderHintId}
      />
    );
  }

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
