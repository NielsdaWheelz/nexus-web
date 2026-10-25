"use client";

import {
  Fragment,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import PaneSurface from "@/components/ui/PaneSurface";
import ResourceList from "@/components/ui/ResourceList";
import SortableList from "@/components/sortable/SortableList";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import type { CollectionRowView, OrderPresentation } from "@/lib/collections/types";
import { PaneRefreshAnchor, usePaneReturnDescendantReady } from "@/lib/workspace/paneReturnMemento";
import CollectionRow from "./CollectionRow";
import { findPaneChromeFocusTarget, findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { focusableElements } from "@/lib/ui/overlay";

function followingRow(root: HTMLElement, rowId: string, orderedIds: readonly string[]): HTMLElement | undefined {
  const remaining = new Map(Array.from(root.querySelectorAll<HTMLElement>("[data-collection-row-id]"))
    .map(row => [row.dataset.collectionRowId!, row]));
  for (let index = orderedIds.indexOf(rowId) + 1; index < orderedIds.length; index += 1) {
    const row = remaining.get(orderedIds[index]);
    if (row) return row;
  }
}

export interface CollectionViewRowRenderProps {
  readonly afterRemoval: () => HTMLElement | null;
  readonly row: CollectionRowView;
  readonly as?: "li" | "div";
  readonly primaryControl?: ReactNode;
  readonly rowActionsAvailable: boolean;
}

/**
 * Orchestrates the one canonical collection path. Panes own retrieval, toolbar,
 * and at most one row-level primary control; they do not
 * own row chrome, action placement, density, or alternate views.
 * Rows commit directly; anchorKey separates view changes from same-view refreshes.
 */
export default function CollectionView({
  returnScope,
  rows,
  status,
  ariaLabel,
  toolbar,
  notice,
  error,
  empty,
  footer,
  rowControls,
  renderRow,
  rowActionsAvailable = true,
  order,
  collectionBusy,
  surface = true,
  anchorKey,
}: {
  readonly returnScope: string;
  readonly rows: readonly CollectionRowView[];
  readonly status: "loading" | "error" | "ready";
  readonly ariaLabel: string;
  readonly toolbar?: ReactNode;
  readonly notice?: ReactNode;
  readonly error?: ReactNode;
  readonly empty?: ReactNode;
  readonly footer?: ReactNode;
  readonly rowControls?: Readonly<Record<string, ReactNode>>;
  readonly renderRow?: (props: CollectionViewRowRenderProps) => ReactNode;
  readonly rowActionsAvailable?: boolean;
  readonly order?: OrderPresentation;
  readonly collectionBusy?: boolean;
  readonly surface?: boolean;
  readonly anchorKey?: string;
}) {
  const returnScopeRef = useRef<HTMLDivElement | null>(null);
  const ownedFocusRef = useRef<{
    target: HTMLElement;
    rowId: string;
    controlSelector: string | null;
    orderedIds: readonly string[];
  } | null>(null);
  const renderedIds = useMemo(() => rows.map(row => row.id), [rows]);
  useLayoutEffect(() => {
    const focus = ownedFocusRef.current;
    const root = returnScopeRef.current;
    if (focus === null || root === null) return;
    if (focus.target.isConnected) {
      focus.orderedIds = renderedIds;
      return;
    }
    if (document.activeElement !== document.body || root.closest("[inert]")) return;
    ownedFocusRef.current = null;
    const remaining = Array.from(root.querySelectorAll<HTMLElement>("[data-collection-row-id]"));
    const sameRow = remaining.find((item) => item.dataset.collectionRowId === focus.rowId);
    const control = sameRow?.querySelector<HTMLElement>(focus.controlSelector ?? "[data-row-focusable]:not([disabled])");
    const sameControl = control?.hasAttribute("data-row-primary-control")
      ? focusableElements(control)[0] : control;
    const following = followingRow(root, focus.rowId, focus.orderedIds);
    const paneId = root.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
    const target = sameControl ?? sameRow?.querySelector<HTMLElement>("[data-row-focusable]:not([disabled])") ??
      following?.querySelector<HTMLElement>("a[href], button:not([disabled])") ??
      root.closest<HTMLElement>('section[aria-label][tabindex="-1"], [role="region"][aria-label][tabindex="-1"]') ??
      findPaneChromeFocusTarget(paneId) ?? findPaneLandmarkFocusTarget(paneId);
    target?.focus({ preventScroll: true });
  });
  const renderCollectionRow = useCallback((
    row: CollectionRowView,
    as?: "li" | "div",
  ) => {
    const props: CollectionViewRowRenderProps = {
      afterRemoval: () => {
        const root = returnScopeRef.current;
        const paneId = root?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
        return (root && followingRow(root, row.id, renderedIds)?.querySelector<HTMLElement>("[data-row-focusable]"))
          ?? root?.closest<HTMLElement>('section[aria-label][tabindex="-1"], [role="region"][aria-label][tabindex="-1"]')
          ?? findPaneChromeFocusTarget(paneId) ?? findPaneLandmarkFocusTarget(paneId);
      },
      row,
      as,
      primaryControl: rowControls?.[row.id],
      rowActionsAvailable,
    };
    return renderRow ? renderRow(props) : <CollectionRow {...props} />;
  }, [renderedIds, rowControls, rowActionsAvailable, renderRow]);
  const renderSortableRow = useCallback((row: CollectionRowView) => renderCollectionRow(row, "div"), [renderCollectionRow]);
  usePaneReturnDescendantReady({
    rootRef: returnScopeRef,
    ready: status !== "loading",
  });
  const body =
    status === "loading" ? (
      <PaneLoadingState
        label={`Loading ${ariaLabel}…`}
        announcement="Polite"
      />
    ) : status === "error" ? (
      error
    ) : rows.length === 0 ? (
      empty
    ) : order ? (
      <SortableList
        key={order.scopeKey}
        items={rows}
        order={order}
        ariaLabel={ariaLabel}
        busy={collectionBusy}
        renderItem={renderSortableRow}
      />
    ) : (
      <ResourceList ariaLabel={ariaLabel} busy={collectionBusy}>
        {rows.map((row) => (
          <Fragment key={row.id}>{renderCollectionRow(row)}</Fragment>
        ))}
      </ResourceList>
    );

  return (
    <PaneRefreshAnchor identity={`${returnScope}:${anchorKey ?? ""}`} value={rows} ready={status === "ready"}>
    <div
      ref={returnScopeRef}
      data-pane-return-scope={returnScope}
      data-order-scope={order?.scopeKey}
      onFocusCapture={(event) => {
        const target = event.target as HTMLElement;
        const row = target.closest<HTMLElement>("[data-collection-row-id]");
        if (!row) return;
        const href = target.getAttribute("href");
        let controlSelector: string | null = null;
        if (target.matches("[data-row-focusable]")) {
          controlSelector = "[data-row-focusable]:not([disabled])";
        } else if (target.matches("[data-row-actions-control]")) {
          controlSelector = "[data-row-actions-control]";
        } else if (target.closest("[data-row-primary-control]")) {
          controlSelector = "[data-row-primary-control]";
        } else if (href !== null) {
          controlSelector = `a[href="${CSS.escape(href)}"]`;
        }
        ownedFocusRef.current = { target, rowId: row.dataset.collectionRowId!, controlSelector,
          orderedIds: renderedIds };
      }}
      onBlurCapture={(event) => {
        if (event.target.isConnected && (event.relatedTarget === null ||
          !event.currentTarget.contains(event.relatedTarget as Node))) ownedFocusRef.current = null;
      }}
      style={{ display: "contents" }}
    >
      {surface ? (
        <PaneSurface
          toolbar={toolbar}
          state={notice}
          footer={footer}
        >
          {body}
        </PaneSurface>
      ) : (
        <>
          {toolbar}
          {notice}
          {body}
          {footer}
        </>
      )}
    </div>
    </PaneRefreshAnchor>
  );
}
