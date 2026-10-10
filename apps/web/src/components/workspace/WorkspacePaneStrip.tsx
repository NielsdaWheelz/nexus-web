"use client";

import { Maximize2, Minus, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { getPaneRouteIcon } from "@/lib/panes/paneRouteModel";
import styles from "./WorkspacePaneStrip.module.css";

export interface StripItem {
  readonly paneId: string;
  readonly href: string;
  readonly label: string;
  readonly pending: boolean;
  readonly isActive: boolean;
  readonly isInView: boolean;
  readonly minimized: boolean;
  readonly canMinimize: boolean;
}

/**
 * The desktop pane strip: one tab per pane in workspace order, a roving
 * toolbar (←/→/Home/End move, Delete/Backspace close), and per tab Minimize or
 * Restore and Close. After its own commands focus stays in the strip: on the
 * named tab, or ("Active") on whichever tab the store made active.
 */
export default function WorkspacePaneStrip(props: {
  readonly items: readonly StripItem[];
  readonly onActivate: (paneId: string) => void;
  readonly onRestore: (paneId: string) => void;
  readonly onMinimize: (paneId: string) => void;
  readonly onClose: (paneId: string) => void;
}) {
  const { items } = props;
  const activators = useRef(new Map<string, HTMLButtonElement>());
  const [roving, setRoving] = useState<string | null>(null);
  const [focusAfter, setFocusAfter] = useState<string | null>(null);
  const focusable =
    items.find((item) => item.paneId === roving)?.paneId ??
    items.find((item) => item.isActive)?.paneId ??
    items[0]?.paneId;

  useEffect(() => {
    if (focusAfter === null) return;
    const paneId =
      items.find((item) =>
        focusAfter === "Active" ? item.isActive : item.paneId === focusAfter,
      )?.paneId ?? items[0]?.paneId;
    setFocusAfter(null);
    if (!paneId) return;
    setRoving(paneId);
    activators.current.get(paneId)?.focus();
  }, [focusAfter, items]);

  const focusTab = (paneId: string) => {
    setRoving(paneId);
    activators.current.get(paneId)?.focus();
  };
  const restore = (paneId: string) => {
    setFocusAfter(paneId);
    props.onRestore(paneId);
  };
  const close = (index: number) => {
    const paneId = items[index]!.paneId;
    setFocusAfter(
      items[index + 1]?.paneId ?? items[index - 1]?.paneId ?? "Active",
    );
    props.onClose(paneId);
  };
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const last = items.length - 1;
    const byKey: Partial<Record<string, number>> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const target = byKey[event.key];
    if (target !== undefined) {
      event.preventDefault();
      focusTab(items[target]!.paneId);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      close(index);
    }
  };

  return (
    <div className={styles.root}>
      <div
        className={styles.switcher}
        role="toolbar"
        aria-label="Workspace panes"
      >
        {items.map((item, index) => {
          const RouteIcon = getPaneRouteIcon(item.href);
          return (
            <div
              key={item.paneId}
              className={styles.tab}
              data-active={item.isActive || undefined}
              data-in-view={item.isInView || undefined}
              data-minimized={item.minimized || undefined}
            >
              <button
                type="button"
                ref={(element) => {
                  if (element) activators.current.set(item.paneId, element);
                  else activators.current.delete(item.paneId);
                }}
                className={styles.activator}
                tabIndex={item.paneId === focusable ? 0 : -1}
                aria-current={item.isActive ? "page" : undefined}
                aria-label={item.pending ? item.label : undefined}
                aria-busy={item.pending || undefined}
                title={item.pending ? undefined : item.label}
                onClick={() =>
                  item.minimized
                    ? restore(item.paneId)
                    : props.onActivate(item.paneId)
                }
                onFocus={() => setRoving(item.paneId)}
                onKeyDown={(event) => onKeyDown(event, index)}
              >
                <RouteIcon
                  aria-hidden
                  size={16}
                  strokeWidth={1.75}
                  className={styles.icon}
                />
                {item.pending ? (
                  <span className={styles.titleSkeleton} aria-hidden />
                ) : (
                  <span className={styles.title}>{item.label}</span>
                )}
                {item.isActive ? (
                  <span className="sr-only"> Active pane.</span>
                ) : null}
                {item.minimized ? (
                  <span className="sr-only"> Minimized. Restore.</span>
                ) : null}
              </button>
              <div className={styles.actions}>
                <button
                  type="button"
                  tabIndex={-1}
                  className={styles.action}
                  aria-label={`${item.minimized ? "Restore" : "Minimize"} ${item.label}`}
                  disabled={!item.minimized && !item.canMinimize}
                  onClick={() => {
                    if (item.minimized) return restore(item.paneId);
                    setFocusAfter(item.isActive ? "Active" : item.paneId);
                    props.onMinimize(item.paneId);
                  }}
                >
                  {item.minimized ? (
                    <Maximize2 aria-hidden size={14} strokeWidth={2} />
                  ) : (
                    <Minus aria-hidden size={14} strokeWidth={2} />
                  )}
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  className={styles.action}
                  aria-label={`Close ${item.label}`}
                  onClick={() => close(index)}
                >
                  <X aria-hidden size={14} strokeWidth={2} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
