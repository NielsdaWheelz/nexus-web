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
import { useMeasuredIndexWindow, type IndexGeometry } from "@/lib/collections/measuredIndexWindow";
import { IndexRowWindow } from "@/lib/collections/indexRowWindow";
import { usePaneCollectionGeometry } from "@/lib/workspace/paneReturnMemento";

export interface CollectionViewRowRenderProps {
  readonly afterRemoval: () => HTMLElement | null;
  readonly row: CollectionRowView;
  readonly as?: "li" | "div";
  readonly primaryControl?: ReactNode;
  readonly rowActionsAvailable: boolean;
  readonly listPosition?: { readonly index: number; readonly count: number };
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
  geometry = null,
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
  /** The caller guarantees canonical two-line Index rows, including custom renderers. */
  readonly geometry?: IndexGeometry | null;
}) {
  const returnScopeRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const ownedFocusRef = useRef<{
    target: HTMLElement;
    rowId: string;
    controlSelector: string | null;
    orderedIds: readonly string[];
  } | null>(null);
  const orderedIds = useMemo(() => rows.map(row => row.id), [rows]);
  const scopeKey = `${returnScope}:${anchorKey ?? ""}`;
  const scrollport = useCallback(() => listRef.current?.closest<HTMLElement>('[data-pane-content][data-body-mode="standard"]') ?? null, []);
  const window = useMeasuredIndexWindow({ scopeKey, ids: orderedIds, geometry: status === "ready" ? geometry : null, listRef, scrollport });
  usePaneCollectionGeometry({ scope: returnScope, window });
  const windowed = window.plan.kind !== "Intrinsic";
  const ready = status !== "loading" && window.plan.kind !== "Measure";
  const committedIds = useRef(orderedIds);
  useLayoutEffect(() => { committedIds.current = orderedIds; });
  const pendingFocus = useRef<{ id: string; selector: string; fallback: HTMLElement | null; release: () => void } | null>(null);
  const fallbackTarget = useCallback(() => {
    const root = returnScopeRef.current;
    const paneId = root?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
    return root?.closest<HTMLElement>('section[aria-label][tabindex="-1"], [role="region"][aria-label][tabindex="-1"]')
      ?? findPaneLandmarkFocusTarget(paneId) ?? findPaneChromeFocusTarget(paneId);
  }, []);
  const recover = useCallback((id: string, previous: readonly string[], sameRow = false) => {
    const selector = "[data-row-focusable]:not([disabled])";
    const root = returnScopeRef.current;
    const latest = new Set(committedIds.current);
    const next = sameRow && latest.has(id) ? id : previous.slice(previous.indexOf(id) + 1).find(candidate => latest.has(candidate));
    const mounted = next ? window.rowElement(next)?.querySelector<HTMLElement>(selector) : null;
    if (mounted?.isConnected) return mounted;
    const fallback = fallbackTarget();
    if (next && root && windowed) {
      pendingFocus.current?.release();
      pendingFocus.current = { id: next, selector, fallback, release: window.pin(next) };
    }
    return fallback;
  }, [window.rowElement, window.pin, windowed, fallbackTarget]);
  useLayoutEffect(() => () => { pendingFocus.current?.release(); pendingFocus.current = null; }, [scopeKey]);
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (pending && !returnScopeRef.current?.closest("[inert]")) {
      const active = document.activeElement;
      if (active !== document.body && active !== pending.fallback) {
        pending.release(); pendingFocus.current = null;
      } else {
        const target = window.rowElement(pending.id)?.querySelector<HTMLElement>(pending.selector);
        if (target) { target.focus({ preventScroll: true }); pending.release(); pendingFocus.current = null; }
      }
    }
    const focus = ownedFocusRef.current;
    const root = returnScopeRef.current;
    if (focus === null || root === null) return;
    if (focus.target.isConnected) {
      focus.orderedIds = orderedIds;
      return;
    }
    if (document.activeElement !== document.body || root.closest("[inert]")) return;
    ownedFocusRef.current = null;
    const remaining = Array.from(root.querySelectorAll<HTMLElement>("[data-collection-row-id]"));
    const sameRow = remaining.find((item) => item.dataset.collectionRowId === focus.rowId);
    const control = sameRow?.querySelector<HTMLElement>(focus.controlSelector ?? "[data-row-focusable]:not([disabled])");
    const sameControl = control?.hasAttribute("data-row-primary-control")
      ? focusableElements(control)[0] : control;
    const paneId = root.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
    const target = sameControl ?? sameRow?.querySelector<HTMLElement>("[data-row-focusable]:not([disabled])") ??
      recover(focus.rowId, focus.orderedIds, true) ?? findPaneLandmarkFocusTarget(paneId);
    target?.focus({ preventScroll: true });
  });
  const renderCollectionRow = useCallback((
    row: CollectionRowView,
    as?: "li" | "div",
    index?: number,
  ) => {
    const props: CollectionViewRowRenderProps = {
      afterRemoval: () => {
        return recover(row.id, orderedIds);
      },
      row,
      as,
      primaryControl: rowControls?.[row.id],
      rowActionsAvailable,
      listPosition: windowed && index !== undefined && as !== "div" ? { index, count: orderedIds.length } : undefined,
    };
    return <IndexRowWindow window={window} id={row.id}>{renderRow ? renderRow(props) : <CollectionRow {...props} />}</IndexRowWindow>;
  }, [orderedIds, rowControls, rowActionsAvailable, renderRow, recover, window, windowed]);
  const renderSortableRow = useCallback((row: CollectionRowView) => renderCollectionRow(row, "div"), [renderCollectionRow]);
  usePaneReturnDescendantReady({
    rootRef: returnScopeRef,
    ready,
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
        window={window}
        listRef={listRef}
      />
    ) : (
      <>
      {window.plan.kind === "Measure" ? <PaneLoadingState label={`Loading ${ariaLabel}…`} announcement="None" /> : null}
      <ResourceList ref={listRef} ariaLabel={ariaLabel} busy={collectionBusy || !ready} windowed={windowed} measuring={window.plan.kind === "Measure"}>
        {(window.plan.kind === "Measure" ? [{ id: window.plan.sampleId, index: 0, gapBeforePx: 0 }] : window.plan.slots).map(slot => {
          const row = rows[slot.index];
          return row ? <Fragment key={row.id}>
            {slot.gapBeforePx > 0 ? <li role="presentation" aria-hidden="true" style={{ height: slot.gapBeforePx, flexShrink: 0 }} /> : null}
            {renderCollectionRow(row, undefined, slot.index)}
          </Fragment> : null;
        })}
        {window.plan.kind === "Ready" && window.plan.tailGapPx > 0 ? <li role="presentation" aria-hidden="true" style={{ height: window.plan.tailGapPx, flexShrink: 0 }} /> : null}
      </ResourceList>
      </>
    );

  return (
    <PaneRefreshAnchor identity={`${returnScope}:${anchorKey ?? ""}`} value={rows} ready={status === "ready"}>
    <div
      ref={returnScopeRef}
      data-pane-return-scope={returnScope}
      data-order-scope={order?.scopeKey}
      onPointerDownCapture={(event) => {
        const row = (event.target as Element).closest<HTMLElement>("[data-collection-row-id]");
        if (row?.dataset.collectionRowId) window.interact(row.dataset.collectionRowId);
      }}
      onFocusCapture={(event) => {
        const target = event.target as HTMLElement;
        const row = target.closest<HTMLElement>("[data-collection-row-id]");
        if (!row) return;
        window.interact(row.dataset.collectionRowId!);
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
          orderedIds };
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
