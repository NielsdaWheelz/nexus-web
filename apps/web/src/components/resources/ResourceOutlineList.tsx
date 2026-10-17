"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useLayoutEffect, useState, type ReactNode } from "react";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { definePaneVisitDataKey, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";
import styles from "./ResourceOutline.module.css";

type View = { folds: ReadonlyMap<string, boolean>; focused: string | null };
export const ResourceOutlineContext = createContext<{
  view: View;
  toggle(key: string, open: boolean): void;
  focus(key: string | null): void;
} | null>(null);
export const ResourceAncestors = createContext<ReadonlyMap<string, string>>(new Map());

type Props = { children: ReactNode; ariaLabel: string; scope: string; ancestorRef?: string; busy?: boolean };

/** The same native list holds roots and disclosed children; folds belong to a visit. */
export default function ResourceOutlineList(props: Props) {
  const parent = useContext(ResourceOutlineContext);
  const runtime = usePaneRuntime();
  if (parent) return <ul className={styles.list} aria-label={props.ariaLabel} aria-busy={props.busy}>{props.children}</ul>;
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

function RootList({ children, ariaLabel, scope, ancestorRef, busy, restored, capture }: Props & { restored: View | null; capture: ((view: View) => void) | null }) {
  const [view, setView] = useState<View>(() => restored ?? { folds: new Map(), focused: null });
  useLayoutEffect(() => { capture?.(view); }, [capture, view]);
  const context = useMemo(() => ({
    view,
    toggle: (key: string, open: boolean) => setView((old) => ({ ...old, folds: new Map(old.folds).set(key, open) })),
    focus: (focused: string | null) => setView((old) => ({ ...old, focused })),
  }), [view]);
  const ancestors = useMemo(() => new Map(ancestorRef ? [[ancestorRef, scope]] : []), [ancestorRef, scope]);
  return <ResourceOutlineContext value={context}><ResourceAncestors value={ancestors}>
    <div className={styles.outline} data-pane-return-scope={scope} data-outline-scope={scope}>
      {view.focused !== null ? <button type="button" className={styles.textButton} onClick={(event) => {
        const root = event.currentTarget.parentElement;
        const previous = view.focused;
        context.focus(null);
        requestAnimationFrame(() => root?.querySelector<HTMLElement>(`[data-outline-occurrence="${CSS.escape(previous!)}"] [data-row-focusable]`)?.focus({ preventScroll: true }));
      }}>back to all items</button> : null}
      <ul className={styles.list} aria-label={ariaLabel} aria-busy={busy} tabIndex={-1}>{children}</ul>
    </div>
  </ResourceAncestors></ResourceOutlineContext>;
}
