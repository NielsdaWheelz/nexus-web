"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useLayoutEffect, useState, type ReactNode } from "react";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { OutlineBranch, OutlineTarget } from "@/lib/resources/outlineProjection";
import { definePaneVisitDataKey, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";
import styles from "./ResourceOutline.module.css";

type View = { folds: ReadonlyMap<string, boolean>; focused: string | null };
export const ResourceOutlineContext = createContext<{
  scope: string;
  view: View;
  toggle(key: string, open: boolean): void;
  focus(key: string): void;
  showAll(): void;
  reveal(target: OutlineTarget): void;
  focusedRowRemoved(key: string, row: HTMLElement): void;
} | null>(null);
export const ResourceBranch = createContext<OutlineBranch>({ ancestors: new Map(), traversedEdgeIds: new Set() });

type Props = {
  children: ReactNode;
  after?: ReactNode;
  ariaLabel: string;
  scope: string;
  ancestorRef?: string;
  branch?: OutlineBranch;
  onRevealRoot?: () => void;
  onFocusChange?: (focused: string | null) => void;
  busy?: boolean;
};

/** Native lists share one visit's folds and reveal scope; ancestry follows occurrences. */
export default function ResourceOutlineList(props: Props) {
  const parent = useContext(ResourceOutlineContext);
  const inherited = useContext(ResourceBranch);
  const runtime = usePaneRuntime();
  if (parent) return <ResourceBranch value={props.branch ?? inherited}>
    <ul className={styles.list} aria-label={props.ariaLabel} aria-busy={props.busy}>{props.children}</ul>
    {props.after}
  </ResourceBranch>;
  return runtime ? <VisitedList key={`${runtime.visitId}:${props.scope}`} {...props} /> : <RootList key={props.scope} {...props} restored={null} capture={null} />;
}

function VisitedList(props: Props) {
  const current = useRef<View | null>(null);
  const key = useMemo(() => definePaneVisitDataKey<View>(`ResourceOutline:${props.scope}`), [props.scope]);
  const restored = usePaneVisitData(key, useCallback(() => current.current, []));
  const write = usePaneVisitDataWriter(key);
  const capture = useCallback((value: View) => { current.current = value; write(value); }, [write]);
  return <RootList {...props} restored={restored} capture={capture} />;
}

function RootList({ children, after, ariaLabel, scope, ancestorRef, branch: suppliedBranch, onRevealRoot, onFocusChange, busy, restored, capture }: Props & { restored: View | null; capture: ((view: View) => void) | null }) {
  const inherited = useContext(ResourceBranch);
  const [view, setView] = useState<View>(() => restored ?? { folds: new Map(), focused: null });
  const root = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const focusedKey = useRef(view.focused);
  const pendingFocus = useRef<{ key: string; previous: Element | null } | null>(null);
  const focusChanged = useRef(onFocusChange);
  focusChanged.current = onFocusChange;
  const reveal = useCallback((target: OutlineTarget) => {
    if (target.kind === "root" && view.focused === null && onRevealRoot) { onRevealRoot(); return; }
    const key = target.kind === "occurrence" ? target.key : view.focused;
    const occurrence = key === null ? list.current : root.current?.querySelector<HTMLElement>(`[data-outline-occurrence="${CSS.escape(key)}"]`);
    if (!occurrence) return;
    const control = key === null || occurrence.matches("[data-row-focusable]") ? occurrence : occurrence.querySelector<HTMLElement>("[data-row-focusable]");
    control?.focus();
  }, [onRevealRoot, view.focused]);
  const focus = useCallback((focused: string) => {
    pendingFocus.current = { key: focused, previous: document.activeElement };
    setView((old) => ({ ...old, focused }));
  }, []);
  const showAll = useCallback(() => {
    setView((old) => old.focused === null ? old : { ...old, focused: null });
  }, []);
  const focusedRowRemoved = useCallback((key: string, row: HTMLElement) => {
    const previous = document.activeElement;
    const ownedFocus = previous !== null && root.current?.contains(previous);
    // A committed removal ends focus; an initial lazy restoration or ref reattachment does not.
    queueMicrotask(() => {
      const scope = root.current;
      if (!scope?.isConnected || focusedKey.current !== key || row.isConnected || scope.querySelector(`[data-outline-occurrence="${CSS.escape(key)}"]`)) return;
      setView((old) => old.focused === key ? { ...old, focused: null } : old);
      if (ownedFocus && (document.activeElement === previous || (document.activeElement === document.body && !previous?.isConnected))) list.current?.focus();
    });
  }, []);
  useLayoutEffect(() => {
    focusedKey.current = view.focused;
    capture?.(view);
    const pending = pendingFocus.current;
    pendingFocus.current = null;
    if (pending && (document.activeElement === pending.previous || (document.activeElement === document.body && !pending.previous?.isConnected))) reveal({ kind: "occurrence", key: pending.key });
  }, [capture, reveal, view]);
  useLayoutEffect(() => { focusChanged.current?.(view.focused); }, [view.focused]);
  const context = useMemo(() => ({
    scope,
    view,
    toggle: (key: string, open: boolean) => setView((old) => ({ ...old, folds: new Map(old.folds).set(key, open) })),
    focus,
    showAll,
    reveal,
    focusedRowRemoved,
  }), [scope, focus, focusedRowRemoved, reveal, showAll, view]);
  const branch = useMemo(() => {
    const base = suppliedBranch ?? inherited;
    return ancestorRef && !base.ancestors.has(ancestorRef)
      ? { ...base, ancestors: new Map(base.ancestors).set(ancestorRef, { kind: "root" } as const) }
      : base;
  }, [ancestorRef, inherited, suppliedBranch]);
  return <ResourceOutlineContext value={context}><ResourceBranch value={branch}>
    <div ref={root} className={styles.outline} data-pane-return-scope={scope} data-outline-scope={scope}>
      {view.focused !== null ? <button type="button" className={styles.textButton} onClick={() => {
        pendingFocus.current = { key: view.focused!, previous: document.activeElement };
        showAll();
      }}>back to all items</button> : null}
      <ul ref={list} className={styles.list} aria-label={ariaLabel} aria-busy={busy} tabIndex={-1}>{children}</ul>
      {after}
    </div>
  </ResourceBranch></ResourceOutlineContext>;
}
