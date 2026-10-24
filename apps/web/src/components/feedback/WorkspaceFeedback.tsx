"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { readMobileCssLength, useMobileViewport } from "@/lib/mobileShell/viewport";
import { useInteractionOwner } from "@/lib/ui/overlay";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { activityReturnFocus } from "./Activity";
import { Announcement, Signal, type FeedbackActions } from "./Feedback";
import { EMPTY_SIGNALS, transientAction, type createWorkspaceSignals } from "./workspaceSignals";
import styles from "./Feedback.module.css";

/** passive geometry never enters the overlay stack or the shell's measured chrome.
 * an ineligible occurrence retires permanently; geometry cannot replay it.
 */
export default function WorkspaceFeedback({ signals, fallbackFocus }: {
  signals: ReturnType<typeof createWorkspaceSignals>;
  fallbackFocus?: () => HTMLElement | null;
}) {
  const { entries, transient } = useSyncExternalStore(signals.subscribe, signals.snapshot, () => EMPTY_SIGNALS);
  const owner = useInteractionOwner();
  const mobile = useIsMobileViewport();
  const viewport = useMobileViewport();
  const card = useRef<HTMLElement | null>(null);
  const [placed, setPlaced] = useState<object | null>(null);
  const occurrence = transient?.occurrence ?? null;
  const entry = transient && transient.kind !== "Receipt" ? entries.find((item) => item.key === transient.key) : null;
  const content = transient?.kind === "Receipt" ? transient.content : entry?.notice.content;
  const exactAction = transientAction(transient, entries);
  const actions: FeedbackActions | undefined = transient?.kind === "Attention"
    ? [{ label: "review", onClick: () => { if (card.current) signals.openActivity(card.current); } }]
    : exactAction ? [exactAction] : undefined;

  useLayoutEffect(() => { signals.environmentChanged(); }, [signals, owner, mobile]);
  useEffect(() => {
    const focusChanged = () => signals.environmentChanged();
    document.addEventListener("focusin", focusChanged);
    return () => document.removeEventListener("focusin", focusChanged);
  }, [signals]);
  useLayoutEffect(() => {
    const element = card.current;
    if (!occurrence || !element) return;
    let frame: number | null = null;
    let closed = false;
    const measure = () => {
      frame = null;
      if (closed || signals.snapshot().transient?.occurrence !== occurrence) return;
      const workspace = document.querySelector<HTMLElement>("[data-workspace-feedback-root]");
      const pane = workspace?.querySelector<HTMLElement>('[data-pane-shell="true"][data-active="true"] [data-pane-content="true"]');
      const visual = window.visualViewport;
      const visible = { left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0, width: visual?.width ?? window.innerWidth, height: visual?.height ?? window.innerHeight };
      const paneBox = pane?.getBoundingClientRect();
      const workBox = workspace?.getBoundingClientRect();
      if (!paneBox || !workBox || paneBox.width <= 0 || paneBox.height <= 0) {
        closed = true;
        signals.closeTransient(occurrence);
        return;
      }
      const inset = readMobileCssLength("var(--space-4)");
      const left = mobile ? visible.left + readMobileCssLength("max(12px, var(--viewport-safe-left))")
        : Math.max(paneBox.left, workBox.left, visible.left) + inset;
      const right = mobile ? visible.left + visible.width - readMobileCssLength("max(12px, var(--viewport-safe-right))")
        : Math.min(paneBox.right, workBox.right, visible.left + visible.width) - inset;
      const top = mobile ? Math.max(visible.top + 12, readMobileCssLength("var(--mobile-feedback-top)"))
        : Math.max(paneBox.top, workBox.top, visible.top) + inset;
      const bottom = mobile ? visible.top + visible.height - 12
        : Math.min(paneBox.bottom, workBox.bottom, visible.top + visible.height) - inset;
      element.style.maxWidth = `${Math.max(0, Math.min(readMobileCssLength("24rem"), right - left))}px`;
      const size = element.getBoundingClientRect();
      if (right <= left || size.width > right - left || size.height > bottom - top) {
        closed = true;
        signals.closeTransient(occurrence);
        return;
      }
      element.style.left = `${mobile ? left : right - size.width}px`;
      element.style.top = `${top}px`;
      setPlaced(occurrence);
      // the measured placement is painted before its visible-time clock begins.
      frame = requestAnimationFrame(() => { frame = null; signals.placement(occurrence, true); });
    };
    const schedule = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    const workspace = document.querySelector<HTMLElement>("[data-workspace-feedback-root]");
    if (workspace) observer.observe(workspace);
    const pane = workspace?.querySelector<HTMLElement>('[data-pane-shell="true"][data-active="true"] [data-pane-content="true"]');
    if (pane) observer.observe(pane);
    const mutations = new MutationObserver(schedule);
    if (workspace) mutations.observe(workspace, { attributes: true, attributeFilter: ["data-active", "hidden", "inert", "class"], childList: true, subtree: true });
    const unsubscribe = viewport.subscribeContentBottomClearance(schedule);
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    const release = () => signals.hold(occurrence, "Press", false);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    measure();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      unsubscribe();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      signals.placement(occurrence, false);
    };
  }, [signals, viewport, mobile, occurrence]);

  if (!transient || !content || typeof document === "undefined") return null;
  return createPortal(<div className={styles.transientLayer}>
    <section ref={card} className={styles.transient} data-placed={placed === occurrence || undefined} aria-label="notification"
      onPointerEnter={(event) => { if (event.pointerType === "mouse") signals.hold(transient.occurrence, "Pointer", true); }}
      onPointerLeave={() => signals.hold(transient.occurrence, "Pointer", false)}
      onPointerDown={() => signals.hold(transient.occurrence, "Press", true)}
      onFocus={() => signals.hold(transient.occurrence, "Focus", true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) signals.hold(transient.occurrence, "Focus", false); }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        signals.closeTransient(transient.occurrence);
      }}>
      <Signal content={{ tone: content.tone, title: content.title }} actions={actions} announcement="None"
        plain className={styles.transientSignal} occurrence={transient.occurrence}
        onDismiss={() => signals.closeTransient(transient.occurrence)} dismissLabel="close notification" dismissBlocked={false}
        returnFocus={() => activityReturnFocus(null, fallbackFocus)} />
    </section>
    {placed === occurrence && !owner ? <Announcement text={content.title} level="Polite" occurrence={transient.occurrence} /> : null}
  </div>, document.body);
}
