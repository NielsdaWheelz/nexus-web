"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
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
  sortable,
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
  readonly sortable?: {
    readonly disabled?: boolean;
    readonly onReorder: (nextRows: CollectionRowView[]) => void;
  };
  readonly surface?: boolean;
}) {
  const transitionScopeId = useId();
  const returnScopeRef = useRef<HTMLDivElement | null>(null);
  const viewTransitionsReady = useClientViewTransitionsReady();
  const rowOrderSignature = useMemo(
    () => rows.map((row) => row.id).join("\u001f"),
    [rows],
  );
  const [displayRows, setDisplayRows] = useState<readonly CollectionRowView[]>(rows);
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
  usePaneReturnDescendantReady({
    rootRef: returnScopeRef,
    ready:
      status !== "loading" &&
      (status !== "ready" ||
        displayRowOrderSignatureRef.current === rowOrderSignature),
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
        renderItem={({ item: row, activatorProps }) => {
          return (
            <CollectionRow
              row={row}
              reorder={activatorProps}
              as="div"
              panel={rowPanels?.[row.id]}
              primaryControl={rowControls?.[row.id]}
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
      <ResourceList ariaLabel={ariaLabel}>
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
