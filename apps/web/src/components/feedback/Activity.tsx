"use client";

import { Activity as ActivityIcon } from "lucide-react";
import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import MobileSheet from "@/components/ui/MobileSheet";
import { OverlayContext, useInteractionOwner } from "@/lib/ui/overlay";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { Announcement, FeedbackContext, Signal } from "./Feedback";
import { EMPTY_SIGNALS, type createWorkspaceSignals, type WorkspaceSignal } from "./workspaceSignals";
import styles from "./Feedback.module.css";

export interface ActivityAccess {
  readonly total: number;
  readonly attention: number;
  readonly undoAvailable: number;
  open(trigger: HTMLElement): void;
}

export function useActivity(): ActivityAccess {
  const signals = useContext(FeedbackContext);
  if (!signals) throw new Error("useActivity requires FeedbackProvider");
  const { entries } = useSyncExternalStore(signals.subscribe, signals.snapshot, () => EMPTY_SIGNALS);
  return useMemo(() => ({
    total: entries.length,
    attention: entries.filter((entry) => entry.notice.needsAttention).length,
    undoAvailable: entries.filter((entry) => entry.undo && !entry.notice.actions?.some((action) => action.busy)).length,
    open: signals.openActivity,
  }), [entries, signals]);
}

/** the workspace reports committed navigation, including asynchronous recovery. */
export function useActivityNavigation(generation: number, pendingFocus: object | null): void {
  const signals = useContext(FeedbackContext);
  if (!signals) throw new Error("useActivityNavigation requires FeedbackProvider");
  const previous = useRef({ generation, pendingFocus });
  useLayoutEffect(() => {
    if (previous.current.generation !== generation || (pendingFocus !== null && previous.current.pendingFocus !== pendingFocus))
      signals.navigationCommitted();
    previous.current = { generation, pendingFocus };
  }, [generation, pendingFocus, signals]);
}

/** the badge names current facts; its fixed slot is never an unread counter. */
export function ActivityControl({ className, iconOnly = true }: { className?: string; iconOnly?: boolean }) {
  const activity = useActivity();
  const label = `activity: ${activity.total} current ${activity.total === 1 ? "item" : "items"}; ${activity.attention} ${activity.attention === 1 ? "needs" : "need"} attention; ${activity.undoAvailable} undo available`;
  const icon = <span className={styles.activityGlyph}>
    <ActivityIcon size={20} />
    <span className={styles.activityBadge} aria-hidden="true">
      {activity.attention > 0 ? <span className={styles.attentionCount}>{activity.attention > 99 ? "99+" : activity.attention}</span>
        : activity.undoAvailable > 0 ? <span className={styles.undoDot} /> : null}
    </span>
  </span>;
  const props = {
    className,
    "aria-label": label,
    "aria-haspopup": "dialog" as const,
    "data-activity-control": true,
    onClick: (event: MouseEvent<HTMLButtonElement>) => activity.open(event.currentTarget),
  };
  return iconOnly ? <Button {...props} iconOnly icon={icon} /> : <Button {...props} icon={icon}>activity</Button>;
}

function visible(element: HTMLElement | null): element is HTMLElement {
  return element !== null && element.isConnected && !element.closest("[hidden], [inert]")
    && element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible";
}

/** disappearing receipts and hidden reader chrome are never return anchors. */
export function activityReturnFocus(opener: HTMLElement | null, fallback?: () => HTMLElement | null): HTMLElement | null {
  if (visible(opener)) return opener;
  const control = [...document.querySelectorAll<HTMLElement>("[data-activity-control]")].find(visible);
  if (control) return control;
  const destination = fallback?.() ?? null;
  return visible(destination) ? destination : null;
}

export function ActivitySurface({ signals, fallbackFocus }: {
  signals: ReturnType<typeof createWorkspaceSignals>;
  fallbackFocus?: () => HTMLElement | null;
}) {
  const { activity } = useSyncExternalStore(signals.subscribe, signals.snapshot, () => EMPTY_SIGNALS);
  const mobile = useIsMobileViewport();
  const onNavigate = signals.navigationCommitted;
  const modal = {
    initialFocus: (panel: HTMLElement) => panel,
    returnFocusTo: () => activityReturnFocus(activity?.trigger ?? null, fallbackFocus),
    skipReturnFocus: signals.activityNavigated,
  };
  return mobile ? <MobileSheet {...modal} active={activity !== null} ariaLabel="activity" onDismiss={signals.closeActivity}>
    <div className={styles.mobileActivityBody}><ActivityList onNavigate={onNavigate} /></div>
  </MobileSheet> : <Dialog {...modal} open={activity !== null} title="activity" onClose={signals.closeActivity}>
    <ActivityList onNavigate={onNavigate} />
  </Dialog>;
}

const GROUPS = ["needs attention", "current status", "undo available", "other updates"] as const;
function group(entry: WorkspaceSignal): number {
  return entry.notice.needsAttention ? 0 : entry.kind === "Condition" ? 1 : entry.undo ? 2 : 3;
}

/** one flat keyed parent preserves the exact command node across group changes.
 * hosts supply only their navigating close; requests and settlement stay outside.
 */
export function ActivityList({ onNavigate }: { onNavigate?: () => void }) {
  const signals = useContext(FeedbackContext);
  if (!signals) throw new Error("ActivityList requires FeedbackProvider");
  const { entries } = useSyncExternalStore(signals.subscribe, signals.snapshot, () => EMPTY_SIGNALS);
  const layer = useContext(OverlayContext);
  const owner = useInteractionOwner();
  const exposed = owner === layer;
  const root = useRef<HTMLElement | null>(null);
  const focused = useRef<{ id: number; index: number; element: HTMLElement } | null>(null);
  const previous = useRef<readonly WorkspaceSignal[]>([]);
  const publication = useRef<{ entry: WorkspaceSignal; occurrence: object } | null>(null);
  const [held, setHeld] = useState({ pointer: false, focus: false });
  const order = useRef<readonly number[]>([]);
  const sorted = entries.toSorted((a, b) => group(a) - group(b) || a.rank - b.rank || a.id - b.id);
  const ordered = held.pointer || held.focus
    ? [...order.current.flatMap((id) => entries.find((entry) => entry.id === id) ?? []), ...sorted.filter((entry) => !order.current.includes(entry.id))]
    : sorted;
  order.current = ordered.map((entry) => entry.id);
  const changed = entries.filter((entry) => {
    const old = previous.current.find((item) => item.key === entry.key);
    if (!old) return true;
    if (entry.notice.needsAttention) return !old.notice.needsAttention;
    return old.token !== entry.token || old.notice.content.title !== entry.notice.content.title;
  });
  if (changed.length > 0) publication.current = { entry: changed.toSorted((a, b) => b.id - a.id)[0], occurrence: {} };
  previous.current = entries;
  const published = publication.current;
  const fact = published && entries.some((entry) => entry.key === published.entry.key && entry.token === published.entry.token)
    ? published : null;
  const recover = useCallback(() => {
    const rows = root.current?.querySelectorAll<HTMLElement>("[data-activity-entry]");
    return rows?.[Math.min(focused.current?.index ?? 0, rows.length - 1)] ?? root.current;
  }, []);
  useLayoutEffect(() => {
    const departed = focused.current;
    if (!departed || entries.some((entry) => entry.id === departed.id) || !exposed) return;
    const active = document.activeElement;
    if (active !== document.body && active?.isConnected && !departed.element.contains(active)) return;
    recover()?.focus({ preventScroll: true });
    focused.current = null;
  }, [entries, exposed, recover]);
  const rows: ReactNode[] = [];
  let lastGroup: number | null = null;
  for (const entry of ordered) {
    const currentGroup = group(entry);
    if (currentGroup !== lastGroup) rows.push(<h3 key={`group:${currentGroup}:${entry.id}`} className={styles.activityHeading}>{GROUPS[currentGroup]}</h3>);
    lastGroup = currentGroup;
    rows.push(<Signal
      key={entry.id}
      {...entry.notice}
      activityId={entry.id}
      focusable
      announcement="None"
      disclosure={undefined}
      occurrence={entry.token}
      className={styles.activityItem}
      onDismiss={entry.kind === "Offer" ? () => signals.dismiss(entry) : undefined}
      dismissLabel={entry.undo ? "remove undo" : `dismiss: ${entry.notice.content.title}`}
      dismissText={entry.undo ? "remove undo" : undefined}
      returnFocus={recover}
      onNavigate={onNavigate}
    />);
  }
  return <section ref={root} className={styles.activityList} aria-label="activity" tabIndex={-1}
    onPointerEnter={(event) => { if (event.pointerType === "mouse") setHeld((state) => ({ ...state, pointer: true })); }}
    onPointerLeave={() => setHeld((state) => ({ ...state, pointer: false }))}
    onFocus={(event) => {
      setHeld((state) => ({ ...state, focus: true }));
      const row = event.target.closest<HTMLElement>("[data-activity-entry]");
      focused.current = row ? { id: Number(row.dataset.activityEntry), index: ordered.findIndex((entry) => String(entry.id) === row.dataset.activityEntry), element: row } : null;
    }}
    onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setHeld((state) => ({ ...state, focus: false }));
    }}>
    {rows.length > 0 ? rows : <p className={styles.emptyActivity}>no current activity</p>}
    <Announcement text={fact?.entry.notice.content.title ?? ""} level={fact?.entry.notice.announcement === "None" ? "None" : "Polite"} deferred={!exposed} occurrence={fact?.occurrence} />
  </section>;
}
