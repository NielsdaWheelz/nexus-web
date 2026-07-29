"use client";

import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import PaneSurface from "@/components/ui/PaneSurface";
import ResourceList from "@/components/ui/ResourceList";
import SortableList from "@/components/sortable/SortableList";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import type { CollectionRowView } from "@/lib/collections/types";
import {
  collectionRowViewTransitionName,
  startSameDocumentViewTransition,
  useClientViewTransitionsReady,
} from "@/lib/ui/viewTransitions";
import { usePaneReturnDescendantReady } from "@/lib/panes/paneRuntime";
import CollectionRow from "./CollectionRow";

/**
 * Orchestrates the one canonical collection path. Panes own retrieval, toolbar,
 * optional row panels, and at most one row-level primary control; they do not
 * own row chrome, action placement, density, or alternate views.
 */
export default function CollectionView({
  returnScope,
  rows,
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
  rowActionsAvailable = true,
  sortable,
  collectionBusy,
  surface = true,
}: {
  readonly returnScope: string;
  readonly rows: readonly CollectionRowView[];
  readonly status: "loading" | "error" | "ready";
  readonly ariaLabel: string;
  readonly opener?: ReactNode;
  readonly toolbar?: ReactNode;
  readonly notice?: ReactNode;
  readonly error?: ReactNode;
  readonly empty?: ReactNode;
  readonly footer?: ReactNode;
  readonly rowPanels?: Readonly<Record<string, ReactNode>>;
  readonly rowControls?: Readonly<Record<string, ReactNode>>;
  readonly rowActionsAvailable?: boolean;
  readonly sortable?: {
    readonly disabled?: boolean;
    readonly onReorder: (nextRows: CollectionRowView[]) => void;
  };
  readonly collectionBusy?: boolean;
  readonly surface?: boolean;
}) {
  const transitionScopeId = useId();
  const returnScopeRef = useRef<HTMLDivElement | null>(null);
  const viewTransitionsReady = useClientViewTransitionsReady();
  const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const [displayRows, setDisplayRows] = useState<readonly CollectionRowView[]>(rows);
  const displayRowIdsRef = useRef(rowIds);
  const latestRowsRef = useRef(rows);
  const latestRowIdsRef = useRef(rowIds);
  const transitionUpdatePendingRef = useRef(false);
  latestRowsRef.current = rows;
  latestRowIdsRef.current = rowIds;

  useLayoutEffect(() => {
    if (status !== "ready") {
      displayRowIdsRef.current = rowIds;
      setDisplayRows(rows);
      return;
    }

    const previousIds = displayRowIdsRef.current;
    const sharedPrefix =
      previousIds.length <= rowIds.length &&
      previousIds.every((id, index) => id === rowIds[index]);
    if (sharedPrefix) {
      displayRowIdsRef.current = rowIds;
      setDisplayRows(rows);
      return;
    }
    if (transitionUpdatePendingRef.current) {
      return;
    }

    transitionUpdatePendingRef.current = true;
    startSameDocumentViewTransition(() => {
      transitionUpdatePendingRef.current = false;
      displayRowIdsRef.current = latestRowIdsRef.current;
      setDisplayRows(latestRowsRef.current);
    });
  }, [rowIds, rows, status]);

  const rowsForRender = status === "ready" ? displayRows : rows;
  usePaneReturnDescendantReady({
    rootRef: returnScopeRef,
    ready:
      status !== "loading" &&
      (status !== "ready" ||
        displayRowIdsRef.current === rowIds),
  });
  const body =
    status === "loading" ? (
      <PaneLoadingState label={`Loading ${ariaLabel}…`} />
    ) : status === "error" ? (
      error
    ) : rowsForRender.length === 0 ? (
      empty
    ) : sortable ? (
      <SortableList
        items={rowsForRender}
        getItemId={(row) => row.id}
        onReorder={sortable.onReorder}
        disabled={sortable.disabled}
        ariaLabel={ariaLabel}
        busy={collectionBusy}
        renderItem={({ item: row, activatorProps }) => {
          return (
            <CollectionRow
              row={row}
              reorder={activatorProps}
              as="div"
              panel={rowPanels?.[row.id]}
              primaryControl={rowControls?.[row.id]}
              rowActionsAvailable={rowActionsAvailable}
              viewTransitionName={
                viewTransitionsReady
                  ? collectionRowViewTransitionName(transitionScopeId, row.id)
                  : undefined
              }
            />
          );
        }}
      />
    ) : (
      <ResourceList ariaLabel={ariaLabel} busy={collectionBusy}>
        {rowsForRender.map((row) => (
          <CollectionRow
            key={row.id}
            row={row}
            viewTransitionName={
              viewTransitionsReady
                ? collectionRowViewTransitionName(transitionScopeId, row.id)
                : undefined
            }
            panel={rowPanels?.[row.id]}
            primaryControl={rowControls?.[row.id]}
            rowActionsAvailable={rowActionsAvailable}
          />
        ))}
      </ResourceList>
    );

  return (
    <div
      ref={returnScopeRef}
      data-pane-return-scope={returnScope}
      style={{ display: "contents" }}
    >
      {surface ? (
        <PaneSurface
          opener={opener}
          toolbar={toolbar}
          state={notice}
          footer={status === "ready" ? footer : undefined}
        >
          {body}
        </PaneSurface>
      ) : (
        <>
          {opener}
          {toolbar}
          {notice}
          {body}
          {status === "ready" ? footer : null}
        </>
      )}
    </div>
  );
}
