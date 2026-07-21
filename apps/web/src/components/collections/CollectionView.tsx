"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import PaneSurface from "@/components/ui/PaneSurface";
import ResourceList from "@/components/ui/ResourceList";
import SortableList, {
  type SortableHandleProps,
} from "@/components/sortable/SortableList";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import type { CollectionDensity, CollectionViewMode } from "@/lib/collections/collectionViewState";
import type { CollectionRowView } from "@/lib/collections/types";
import {
  collectionRowViewTransitionName,
  startSameDocumentViewTransition,
  useClientViewTransitionsReady,
} from "@/lib/ui/viewTransitions";
import CollectionGalleryCard from "./CollectionGalleryCard";
import CollectionRow from "./CollectionRow";

/**
 * Orchestrates one collection surface: toolbar, loading/error/empty/ready states,
 * list⟷gallery composition, and the keyboard composite (via `ResourceList`). Panes
 * fetch data, pick a presenter, and hand rows + a toolbar; they own no row chrome.
 * `rowPanels`/`rowControls` are pane-owned nodes keyed by row id (transcript form,
 * library picker) the presenter cannot emit.
 */
export default function CollectionView({
  rows,
  view,
  density,
  status,
  ariaLabel,
  opener,
  toolbar,
  notice,
  error,
  empty,
  footer,
  rowPanels,
  rowControls,
  rowActionsVisibility = "hover",
  sortable,
  surface = true,
}: {
  rows: CollectionRowView[];
  view: CollectionViewMode;
  density: CollectionDensity;
  status: "loading" | "error" | "ready";
  ariaLabel: string;
  opener?: ReactNode;
  toolbar?: ReactNode;
  notice?: ReactNode;
  error?: ReactNode;
  empty?: ReactNode;
  footer?: ReactNode;
  rowPanels?: Record<string, ReactNode>;
  rowControls?: Record<string, ReactNode>;
  rowActionsVisibility?: "hover" | "always";
  sortable?: {
    className?: string;
    itemClassName?: string;
    getRowId?: (row: CollectionRowView) => string;
    onReorder: (nextRows: CollectionRowView[]) => void;
    renderControls?: (
      row: CollectionRowView,
      state: { handleProps: SortableHandleProps; isDragging: boolean },
    ) => ReactNode;
  };
  surface?: boolean;
}) {
  const transitionScopeId = useId();
  const viewTransitionsReady = useClientViewTransitionsReady();
  const rowOrderSignature = useMemo(
    () => rows.map((row) => row.id).join("\u001f"),
    [rows],
  );
  const [displayRows, setDisplayRows] = useState(rows);
  const displayRowOrderSignatureRef = useRef(rowOrderSignature);

  useEffect(() => {
    if (status !== "ready") {
      displayRowOrderSignatureRef.current = rowOrderSignature;
      setDisplayRows(rows);
      return;
    }

    if (displayRowOrderSignatureRef.current === rowOrderSignature) {
      setDisplayRows(rows);
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      startSameDocumentViewTransition(() => {
        displayRowOrderSignatureRef.current = rowOrderSignature;
        setDisplayRows(rows);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [rowOrderSignature, rows, status]);

  const rowsForRender = status === "ready" ? displayRows : rows;
  const body =
    status === "loading" ? (
      <PaneLoadingState label={`Loading ${ariaLabel}…`} />
    ) : status === "error" ? (
      error
    ) : rowsForRender.length === 0 ? (
      empty
    ) : view === "list" && sortable ? (
      <SortableList
        className={sortable.className}
        itemClassName={sortable.itemClassName}
        items={rowsForRender}
        getItemId={sortable.getRowId ?? ((row) => row.id)}
        onReorder={sortable.onReorder}
        resourceList={{ ariaLabel, view, density }}
        renderItem={({ item: row, handleProps, isDragging }) => {
          const rowId = sortable.getRowId?.(row) ?? row.id;
          const sortableControls = sortable.renderControls?.(row, {
            handleProps,
            isDragging,
          });
          const controls =
            sortableControls || rowControls?.[row.id] ? (
              <>
                {sortableControls}
                {rowControls?.[row.id]}
              </>
            ) : undefined;
          return (
            <CollectionRow
              row={{ ...row, selected: row.selected || isDragging }}
              density={density}
              as="div"
              panel={rowPanels?.[row.id]}
              controls={controls}
              actionsVisibility={rowActionsVisibility}
              viewTransitionName={
                viewTransitionsReady
                  ? collectionRowViewTransitionName(transitionScopeId, rowId)
                  : undefined
              }
            />
          );
        }}
      />
    ) : (
      <ResourceList view={view} density={density} ariaLabel={ariaLabel}>
        {rowsForRender.map((row) =>
          view === "gallery" ? (
            <CollectionGalleryCard
              key={row.id}
              row={row}
              viewTransitionName={
                viewTransitionsReady
                  ? collectionRowViewTransitionName(transitionScopeId, row.id)
                  : undefined
              }
            />
          ) : (
            <CollectionRow
              key={row.id}
              row={row}
              density={density}
              viewTransitionName={
                viewTransitionsReady
                  ? collectionRowViewTransitionName(transitionScopeId, row.id)
                  : undefined
              }
              panel={rowPanels?.[row.id]}
              controls={rowControls?.[row.id]}
              actionsVisibility={rowActionsVisibility}
            />
          ),
        )}
      </ResourceList>
    );

  if (!surface) {
    return (
      <>
        {opener}
        {toolbar}
        {notice}
        {body}
        {status === "ready" ? footer : null}
      </>
    );
  }

  return (
    <PaneSurface
      opener={opener}
      toolbar={toolbar}
      state={notice}
      footer={status === "ready" ? footer : undefined}
    >
      {body}
    </PaneSurface>
  );
}
