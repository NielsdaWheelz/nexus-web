"use client";

import {
  Fragment,
  useId,
  useState,
  useContext,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ContributorCreditList } from "@/components/contributors/ContributorCredits";
import type { SortableActivatorProps } from "@/components/sortable/SortableList";
import EmphasisSegments from "@/components/ui/EmphasisSegments";
import { ChevronRight, GripVertical } from "lucide-react";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import { useMobileChromeHold } from "@/lib/mobileShell/chrome";
import Pill from "@/components/ui/Pill";
import { ResourceOutlineContext } from "@/components/resources/ResourceOutlineList";
import ResourceDisclosure from "@/components/resources/ResourceDisclosure";
import ResourceRow from "@/components/ui/ResourceRow";
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
  collectionPublicationYear,
  formatCollectionPublicationDate,
} from "./collectionRowFormatting";
import { assertNever } from "@/lib/assertNever";
import outlineStyles from "@/components/resources/ResourceOutline.module.css";
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

function ReorderMenu({ title, reorder }: {
  readonly title: string;
  readonly reorder: SortableActivatorProps;
}) {
  const hintId = useId();
  const [open, setOpen] = useState(false);
  useMobileChromeHold(open);
  return (
    <>
      <span id={hintId} className="sr-only">
        drag to reorder, or open movement controls. alt plus arrow up moves up;
        alt plus arrow down moves down.
      </span>
      <ActionMenu
        label={`reorder “${title}”`}
        align="start"
        onOpenChange={setOpen}
        triggerRef={reorder.setActivatorNodeRef}
        triggerDisabled={reorder.disabled}
        triggerDisabledReason={reorder.disabledReason}
        options={[
          {
            kind: "command",
            id: "ViewAction.Collection.MoveUp",
            label: "move up",
            disabled: !reorder.canMoveUp,
            disabledReason: !reorder.canMoveUp ? "already first" : undefined,
            onSelect: reorder.moveUp,
          },
          {
            kind: "command",
            id: "ViewAction.Collection.MoveDown",
            label: "move down",
            disabled: !reorder.canMoveDown,
            disabledReason: !reorder.canMoveDown ? "already last" : undefined,
            onSelect: reorder.moveDown,
          },
        ]}
        renderTrigger={(triggerProps) => (
          <Button
            {...triggerProps}
            variant="ghost"
            className={styles.grip}
            data-row-reorder-control=""
            data-dragging={reorder.isDragging || undefined}
            data-can-drag={reorder.canDrag || undefined}
            aria-describedby={[hintId, triggerProps["aria-describedby"]].filter(Boolean).join(" ")}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            onMouseDown={open ? undefined : reorder.listeners.onMouseDown}
            onTouchStart={open ? undefined : reorder.listeners.onTouchStart}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
                (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                event.preventDefault();
                event.stopPropagation();
                if (event.key === "ArrowUp" && reorder.canMoveUp) reorder.moveUp();
                if (event.key === "ArrowDown" && reorder.canMoveDown) reorder.moveDown();
                return;
              }
              if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
              triggerProps.onKeyDown(event);
            }}
          >
            <GripVertical size={16} aria-hidden="true" />
          </Button>
        )}
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
  const mediaLayout = row.mediaIdentity !== undefined;
  const outline = useContext(ResourceOutlineContext);
  const [localOpen,setLocalOpen] = useState(false);
  const occurrenceKey=`${outline?.scope ?? "collection"}/${row.id}`;
  const disclosed = outline?.view.folds.get(row.id) ?? localOpen;
  const setDisclosed = (open:boolean) => outline ? outline.toggle(row.id,open) : setLocalOpen(open);

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
  const date = row.publicationDate !== null ? (
    <time key="date" className={styles.year} dateTime={row.publicationDate}>
      {mediaLayout
        ? collectionPublicationYear(row.publicationDate)
        : formatCollectionPublicationDate(row.publicationDate)}
    </time>
  ) : null;
  const contributors = row.contributors.length > 0 ? (
    <ContributorCreditList
      key="contributors"
      className={styles.contributorList}
      credits={row.contributors}
      maxVisible={row.mediaIdentity === "External" ? row.contributors.length : 2}
      overflowNoun={mediaLayout ? "authors" : "contributors"}
    />
  ) : null;
  if (contributors) supportParts.push(contributors);
  if (date) supportParts.push(date);
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

  const menuLabel = `${mediaLayout ? "more" : "More"} actions for ${row.title.text}`;
  const sections: readonly ContextActionSection[] = [
    {
      id: "View",
      actions: rowActionsAvailable && row.insertionSource ? [{kind: "command",id:"Resource.AddItem",label:"add item",onSelect:()=>{setDisclosed(true);}}] : rowActionsAvailable && !row.resourceRef ? (row.flatActions ?? []) : [],
    },
  ];
  const actions = rowActionsAvailable &&
    (row.resourceRef || sections.some((section) => section.actions.length > 0)) ? (
    <ContextualActionMenu
      sections={sections}
      resourceRef={row.resourceRef ?? undefined}
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
      primary={row.insertionSource ? {kind:"static"} : row.primary}
      selected={row.selected}
      rootProps={{
        "aria-current": row.selected ? "true" : undefined,
        "data-collection-row-id": row.id,
        "data-collection-item-kind": row.kind,
        "data-media-identity": mediaLayout ? "true" : undefined,
        style: rootStyle,
      }}
      title={row.insertionSource && row.primary.kind === "link" ? <><a href={row.primary.href} data-row-focusable="" aria-label={`open ${row.title.text}`}>•</a> {title}</> : title}
      supporting={supporting}
      status={status}
      wrapped={mediaLayout}
      evidence={evidence}
      leadingControl={<>{row.insertionSource ? <button type="button" className={outlineStyles.control} aria-label={`${disclosed ? "hide" : "show"} linked resources for ${row.title.text}`} aria-expanded={disclosed} onClick={() => setDisclosed(!disclosed)}><ChevronRight className={outlineStyles.arrow} data-open={disclosed || undefined} size={14} aria-hidden="true" /></button> : null}{reorder ? <ReorderMenu title={row.title.text} reorder={reorder} /> : null}</>}
      primaryControl={primaryControl}
      actions={actions}
      expanded={<>{panel}{disclosed && row.insertionSource?.kind === "resource" ? <ResourceDisclosure resourceRef={row.insertionSource.ref} occurrencePrefix={occurrenceKey} /> : null}</>}
    />
  );
}
