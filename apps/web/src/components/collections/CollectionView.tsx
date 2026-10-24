"use client";

import {
  Fragment,
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
import type { CollectionRowView, OrderPresentation } from "@/lib/collections/types";
import {
  collectionRowViewTransitionName,
  startSameDocumentViewTransition,
  useClientViewTransitionsReady,
} from "@/lib/ui/viewTransitions";
import { usePaneReturnDescendantReady } from "@/lib/workspace/paneReturnMemento";
import CollectionRow from "./CollectionRow";
import { findPaneChromeFocusTarget } from "@/lib/workspace/paneDom";
import { focusableElements } from "@/lib/ui/overlay";

function followingRowIds(root: HTMLElement, target: HTMLElement): string[] {
  const row = target.closest<HTMLElement>("[data-collection-row-id]");
  if (row === null) return [];
  const all = Array.from(root.querySelectorAll<HTMLElement>("[data-collection-row-id]"));
  return all.slice(all.indexOf(row) + 1).map((item) => item.dataset.collectionRowId!);
}

export interface CollectionViewRowRenderProps {
  readonly afterRemoval: () => HTMLElement | null;
  readonly row: CollectionRowView;
  readonly as?: "li" | "div";
  readonly primaryControl?: ReactNode;
  readonly rowActionsAvailable: boolean;
  readonly viewTransitionName?: string;
}

/**
 * Orchestrates the one canonical collection path. Panes own retrieval, toolbar,
 * and at most one row-level primary control; they do not
 * own row chrome, action placement, density, or alternate views.
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
  rowChangePresentation,
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
  readonly rowChangePresentation?: {
    readonly kind: "ImmediateOnKeyChange";
    readonly key: string;
  };
}) {
  const transitionScopeId = useId();
  const returnScopeRef = useRef<HTMLDivElement | null>(null);
  const ownedFocusRef = useRef<{
    target: HTMLElement;
    rowId: string;
    controlSelector: string | null;
    followingIds: string[];
  } | null>(null);
  const viewTransitionsReady = useClientViewTransitionsReady();
  const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  useLayoutEffect(() => {
    const focus = ownedFocusRef.current;
    const root = returnScopeRef.current;
    if (focus === null || root === null) return;
    if (focus.target.isConnected) {
      focus.followingIds = followingRowIds(root, focus.target);
      return;
    }
    if (document.activeElement !== document.body || root.closest("[inert]")) return;
    ownedFocusRef.current = null;
    const remaining = Array.from(root.querySelectorAll<HTMLElement>("[data-collection-row-id]"));
    const sameRow = remaining.find((item) => item.dataset.collectionRowId === focus.rowId);
    const control = sameRow?.querySelector<HTMLElement>(focus.controlSelector ?? "[data-row-focusable]:not([disabled])");
    const sameControl = control?.hasAttribute("data-row-primary-control")
      ? focusableElements(control)[0] : control;
    const followingRow = focus.followingIds.map((id) => remaining.find((item) => item.dataset.collectionRowId === id))
      .find((item) => item !== undefined);
    const target = sameControl ?? sameRow?.querySelector<HTMLElement>("[data-row-focusable]:not([disabled])") ??
      followingRow?.querySelector<HTMLElement>("a[href], button:not([disabled])") ??
      root.closest<HTMLElement>('section[aria-label][tabindex="-1"], [role="region"][aria-label][tabindex="-1"]') ??
      findPaneChromeFocusTarget(root.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId);
    target?.focus({ preventScroll: true });
  });
  const [displayRows, setDisplayRows] = useState<readonly CollectionRowView[]>(rows);
  const displayRowIdsRef = useRef(rowIds);
  const latestRowsRef = useRef(rows);
  const latestRowIdsRef = useRef(rowIds);
  const transitionUpdatePendingRef = useRef(false);
  const displayedRowChangeKeyRef = useRef(rowChangePresentation?.key);
  latestRowsRef.current = rows;
  latestRowIdsRef.current = rowIds;

  useLayoutEffect(() => {
    if (status !== "ready" || order) {
      displayedRowChangeKeyRef.current = rowChangePresentation?.key;
      displayRowIdsRef.current = rowIds;
      setDisplayRows(rows);
      return;
    }
    if (
      rowChangePresentation?.kind === "ImmediateOnKeyChange" &&
      displayedRowChangeKeyRef.current !== rowChangePresentation.key
    ) {
      displayedRowChangeKeyRef.current = rowChangePresentation.key;
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
  }, [order, rowChangePresentation, rowIds, rows, status]);

  const rowsForRender = status === "ready" && !order ? displayRows : rows;
  const renderCollectionRow = (
    row: CollectionRowView,
    as?: "li" | "div",
  ) => {
    const following = rowsForRender.slice(rowsForRender.indexOf(row) + 1).map(item => item.id);
    const props: CollectionViewRowRenderProps = {
      afterRemoval: () => {
        const root = returnScopeRef.current;
        const remaining = Array.from(root?.querySelectorAll<HTMLElement>("[data-collection-row-id]") ?? []);
        return following.map(id => remaining.find(item => item.dataset.collectionRowId === id)?.querySelector<HTMLElement>("[data-row-focusable]")).find(item => item !== undefined && item !== null)
          ?? root?.closest<HTMLElement>('section[aria-label][tabindex="-1"], [role="region"][aria-label][tabindex="-1"]')
          ?? findPaneChromeFocusTarget(root?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId);
      },
      row,
      as,
      primaryControl: rowControls?.[row.id],
      rowActionsAvailable,
      viewTransitionName: viewTransitionsReady && !order
        ? collectionRowViewTransitionName(transitionScopeId, row.id)
        : undefined,
    };
    return renderRow ? renderRow(props) : <CollectionRow {...props} />;
  };
  usePaneReturnDescendantReady({
    rootRef: returnScopeRef,
    ready:
      status !== "loading" &&
      (order !== undefined || status !== "ready" ||
        displayRowIdsRef.current === rowIds),
  });
  const body =
    status === "loading" ? (
      <PaneLoadingState
        label={`Loading ${ariaLabel}…`}
        announcement="Polite"
      />
    ) : status === "error" ? (
      error
    ) : rowsForRender.length === 0 ? (
      empty
    ) : order ? (
      <SortableList
        key={order.scopeKey}
        items={rowsForRender}
        order={order}
        ariaLabel={ariaLabel}
        busy={collectionBusy}
        renderItem={(row) => renderCollectionRow(row, "div")}
      />
    ) : (
      <ResourceList ariaLabel={ariaLabel} busy={collectionBusy}>
        {rowsForRender.map((row) => (
          <Fragment key={row.id}>{renderCollectionRow(row)}</Fragment>
        ))}
      </ResourceList>
    );

  return (
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
          followingIds: followingRowIds(event.currentTarget, target) };
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
  );
}
