"use client";

import {
  Fragment,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import PaneSurface from "@/components/ui/PaneSurface";
import ResourceList, { ResourceListHead } from "@/components/ui/ResourceList";
import SortableList from "@/components/sortable/SortableList";
import { Ruling } from "@/components/feedback/Ruling";
import { useOptionalAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import type { CollectionRowView, OrderPresentation } from "@/lib/collections/types";
import { PaneRefreshAnchor, usePaneReturnDescendantReady, usePaneScrollMotion } from "@/lib/workspace/paneReturnMemento";
import CollectionRow from "./CollectionRow";
import { findPaneChromeFocusTarget, findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { focusableElements } from "@/lib/ui/overlay";
import { useMeasuredIndexWindow, type IndexGeometry } from "@/lib/collections/measuredIndexWindow";
import { IndexRowWindow } from "@/lib/collections/indexRowWindow";
import { usePaneCollectionGeometry } from "@/lib/workspace/paneReturnMemento";
import styles from "./CollectionView.module.css";

export interface CollectionViewRowRenderProps {
  readonly afterRemoval: () => HTMLElement | null;
  readonly row: CollectionRowView;
  readonly layout: "Rows" | "Wall";
  readonly as?: "li" | "div";
  readonly primaryControl?: ReactNode;
  readonly rowActionsAvailable: boolean;
  readonly listPosition?: { readonly index: number; readonly count: number };
}

/**
 * Orchestrates the one canonical collection path. Panes own retrieval, toolbar,
 * and at most one row-level primary control; they do not
 * own row chrome, action placement or density. Rows may window; Wall mounts every cell.
 * Rows commit directly; anchorKey separates view changes from same-view refreshes.
 */
export default function CollectionView({
  returnScope,
  rows: incoming,
  status,
  ariaLabel,
  toolbar,
  notice,
  error,
  empty,
  footer,
  rowControls,
  renderRow,
  headBefore,
  rowActionsAvailable = true,
  order,
  collectionBusy,
  surface = true,
  anchorKey,
  geometry = null,
  layout = "Rows",
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
  readonly headBefore?: (row: CollectionRowView) => ReactNode;
  readonly rowActionsAvailable?: boolean;
  readonly order?: OrderPresentation;
  readonly collectionBusy?: boolean;
  readonly surface?: boolean;
  readonly anchorKey?: string;
  /** The caller guarantees canonical two-line Index rows, including custom renderers. */
  readonly geometry?: IndexGeometry | null;
  readonly layout?: "Rows" | "Wall";
}) {
  if (headBefore !== undefined && order !== undefined) throw new Error("Manual order cannot contain list heads");
  if (layout === "Wall" && geometry !== null) throw new Error("Wall requires mounted cells");
  if (layout === "Wall" && headBefore !== undefined) throw new Error("Wall cannot contain list heads");
  if (layout === "Wall" && order !== undefined) throw new Error("Wall cannot contain manual order");
  const returnScopeRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const ownedFocusRef = useRef<{
    target: HTMLElement;
    rowId: string;
    controlSelector: string | null;
    orderedIds: readonly string[];
    portal: HTMLElement | null;
    departing: boolean;
  } | null>(null);
  const account = useOptionalAuthenticatedAccount()?.accountId ?? null;
  const scopeKey = JSON.stringify([account, returnScope, anchorKey ?? null, layout]);
  const motion = usePaneScrollMotion();
  const liveHeads = useMemo(() => {
    const result = new Map<string, ReactNode>();
    if (headBefore !== undefined) for (const row of incoming) {
      const head = headBefore(row);
      if (head != null) result.set(row.id, head);
    }
    return result;
  }, [incoming, headBefore]);
  const presentation = useMemo(() => ({ scopeKey, rows: incoming, heads: liveHeads }), [scopeKey, incoming, liveHeads]);
  const committed = useRef(presentation);
  const previous = committed.current;
  const holding = motion !== "still" && previous.scopeKey === scopeKey && previous.rows.length > 0 && order === undefined && layout === "Rows";
  const [sizes, setSizes] = useState<{ scopeKey: string; heights: ReadonlyMap<string, number> } | null>(null);
  const heldSizes = holding && sizes?.scopeKey === scopeKey ? sizes.heights : null;
  const append = useMemo(() => heldSizes !== null && motion === "travel" && incoming.length > previous.rows.length &&
    previous.heads.size === liveHeads.size && [...previous.heads.keys()].every(id => liveHeads.has(id)) &&
    previous.rows.every((row, index) => row.id === incoming[index].id),
    [heldSizes, motion, incoming, previous, liveHeads]);
  const shown = holding && !append ? previous : presentation;
  // The first hold commit keeps its existing contents until the layout effect records
  // their sizes. That effect installs reserved slots before the browser paints.
  const currentRows = holding && heldSizes === null ? previous.rows : incoming;
  const currentHeads = holding && heldSizes === null ? previous.heads : liveHeads;
  const shownStatus = holding ? "ready" : status;
  const rows = shown.rows;
  const currentById = useMemo(() => new Map(currentRows.map(row => [row.id, row])), [currentRows]);
  const orderedIds = useMemo(() => rows.map(row => row.id), [rows]);
  const headIds = useMemo(() => [...shown.heads.keys()], [shown.heads]);
  const headSamples = useMemo(() => [...shown.heads].map(([id, head]) =>
    <ResourceListHead key={id} sampleFor={id}>{head}</ResourceListHead>), [shown.heads]);
  const scrollport = useCallback(() => listRef.current?.closest<HTMLElement>('[data-pane-content][data-body-mode="standard"]') ?? null, []);
  const window = useMeasuredIndexWindow({ scopeKey, ids: orderedIds, headIds, hold: holding,
    geometry: shownStatus === "ready" ? geometry : null, listRef, scrollport });
  const { rowElement, pin } = window;
  usePaneCollectionGeometry({ scope: returnScope, window });
  const windowed = window.plan.kind !== "Intrinsic";
  const ready = shownStatus !== "loading" && window.plan.kind !== "Measure";
  const committedIds = useRef(orderedIds);
  useLayoutEffect(() => {
    committed.current = shown;
    committedIds.current = orderedIds;
    const list = listRef.current;
    if (!holding || list === null) {
      if (sizes !== null) setSizes(null);
      return;
    }
    const measured = new Map(heldSizes);
    if (heldSizes === null) for (const element of list.querySelectorAll<HTMLElement>(":scope > [data-index-head-sample]")) {
      measured.set(`head:${element.dataset.indexHeadSample}`, element.getBoundingClientRect().height);
    }
    const rowHeight = window.plan.kind === "Ready" ? window.plan.height : null;
    for (const element of list.querySelectorAll<HTMLElement>(":scope > [data-collection-row-id], :scope > [data-index-head-before]")) {
      const head = element.dataset.indexHeadBefore;
      const id = head === undefined ? element.dataset.collectionRowId! : `head:${head}`;
      const uniform = head === undefined ? rowHeight : null;
      const height = uniform ?? measured.get(id) ?? element.getBoundingClientRect().height;
      if (uniform === null) measured.set(id, height);
      element.style.setProperty("--index-held-size", `${height}px`);
    }
    if (heldSizes === null || measured.size !== heldSizes.size) setSizes({ scopeKey, heights: measured });
  });
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
    const mounted = next ? rowElement(next)?.querySelector<HTMLElement>(selector) : null;
    if (mounted?.isConnected) return mounted;
    const fallback = fallbackTarget();
    if (next && root && windowed) {
      pendingFocus.current?.release();
      const unpin = pin(next);
      const cancel = () => {
        release();
        if (pendingFocus.current?.release === release) pendingFocus.current = null;
      };
      const release = () => { unpin(); fallback?.removeEventListener("blur", cancel); };
      pendingFocus.current = { id: next, selector, fallback, release };
      fallback?.addEventListener("blur", cancel);
    }
    return fallback;
  }, [rowElement, pin, windowed, fallbackTarget]);
  useLayoutEffect(() => () => { pendingFocus.current?.release(); pendingFocus.current = null; }, [scopeKey]);
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (pending && !returnScopeRef.current?.closest("[inert]")) {
      const active = document.activeElement;
      if (active !== document.body && active !== pending.fallback) {
        pending.release(); pendingFocus.current = null;
      } else {
        const target = rowElement(pending.id)?.querySelector<HTMLElement>(pending.selector);
        if (target) { target.focus({ preventScroll: true }); pending.release(); pendingFocus.current = null; }
      }
    }
    const focus = ownedFocusRef.current;
    const root = returnScopeRef.current;
    if (focus === null || root === null || focus.departing) return;
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
      layout,
      as,
      primaryControl: rowControls?.[row.id],
      rowActionsAvailable,
      listPosition: windowed && index !== undefined && as !== "div" ? { index, count: orderedIds.length } : undefined,
    };
    return <IndexRowWindow window={window} id={row.id}>{renderRow ? renderRow(props) : <CollectionRow {...props} />}</IndexRowWindow>;
  }, [orderedIds, rowControls, rowActionsAvailable, renderRow, recover, window, windowed, layout]);
  const renderSortableRow = useCallback((row: CollectionRowView) => renderCollectionRow(row, "div"), [renderCollectionRow]);
  usePaneReturnDescendantReady({
    rootRef: returnScopeRef,
    ready,
  });
  const slots = window.plan.kind === "Measure" ? [{ id: window.plan.sampleId, index: 0, gapBeforePx: 0 }] : window.plan.slots;
  const body =
    shownStatus === "loading" ? (
      <Ruling />
    ) : shownStatus === "error" ? (
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
    ) : layout === "Wall" ? (
      <ul ref={listRef} className={styles.wall} aria-label={ariaLabel} aria-busy={collectionBusy || !ready}>
        {slots.map(slot => {
          const row = rows[slot.index];
          return row ? <Fragment key={row.id}>{renderCollectionRow(row, undefined, slot.index)}</Fragment> : null;
        })}
      </ul>
    ) : (
      <ResourceList ref={listRef} ariaLabel={ariaLabel} busy={collectionBusy || !ready} windowed={windowed}
        measuring={window.plan.kind === "Measure"} held={heldSizes !== null}>
        {windowed ? headSamples : null}
        {slots.map(slot => {
          const row = currentById.get(slot.id);
          return <Fragment key={slot.id}>
            {slot.gapBeforePx > 0 ? <li role="presentation" aria-hidden="true" style={{ height: slot.gapBeforePx, flexShrink: 0 }} /> : null}
            {shown.heads.has(slot.id) ? <ResourceListHead before={slot.id}>{currentHeads.get(slot.id)}</ResourceListHead> : null}
            {row !== undefined ? renderCollectionRow(row, undefined, slot.index) :
              <li role="presentation" aria-hidden="true" data-collection-row-id={slot.id}
                style={{ blockSize: heldSizes?.get(slot.id) ?? (window.plan.kind === "Ready" ? window.plan.height : undefined), flexShrink: 0 }} />}
          </Fragment>;
        })}
        {window.plan.kind === "Ready" && window.plan.tailGapPx > 0 ? <li role="presentation" aria-hidden="true" style={{ height: window.plan.tailGapPx, flexShrink: 0 }} /> : null}
      </ResourceList>
    );

  return (
    <PaneRefreshAnchor identity={`${returnScope}:${anchorKey ?? ""}`} value={shown} ready={shownStatus === "ready"}>
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
        const pending = pendingFocus.current;
        if (pending && target !== pending.fallback) { pending.release(); pendingFocus.current = null; }
        const row = target.closest<HTMLElement>("[data-collection-row-id]");
        if (!row || !event.currentTarget.contains(row)) {
          // React portal focus still belongs to the row whose menu opened it.
          // A control inside the collection, outside that row, takes ownership.
          const focus = ownedFocusRef.current;
          const previous = event.relatedTarget;
          if (focus && !event.currentTarget.contains(target) && previous instanceof Node &&
              (previous === focus.target || focus.portal?.contains(previous))) {
            focus.portal = target.closest<HTMLElement>('[role="menu"], [role="dialog"]') ?? target;
            focus.departing = false;
          } else ownedFocusRef.current = null;
          return;
        }
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
          orderedIds, portal: null, departing: false };
      }}
      onBlurCapture={(event) => {
        const root = event.currentTarget;
        const focus = ownedFocusRef.current;
        if (event.target.isConnected && (event.relatedTarget === null || !root.contains(event.relatedTarget as Node))) {
          // Departure wins before a synchronous publication can detach its new
          // destination. Only this row's matching portal focus may re-adopt it.
          if (focus) focus.departing = true;
          pendingFocus.current?.release(); pendingFocus.current = null;
          // The matching focus event identifies an owned portal before this
          // check. A real transfer elsewhere relinquishes the old row capture.
          queueMicrotask(() => {
            if (ownedFocusRef.current !== focus) return;
            if (focus?.departing) ownedFocusRef.current = null;
          });
        }
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
