"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { readMobileCssLength, useMobileViewport } from "@/lib/mobileShell/viewport";
import { useInteractionOwner } from "@/lib/ui/overlay";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { Announcement, Signal } from "./Feedback";
import type { createTransientFeedback } from "./transient";
import styles from "./Feedback.module.css";

function visible(element: HTMLElement | null): element is HTMLElement {
  return element !== null && element.isConnected && !element.closest("[hidden], [inert]")
    && element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible";
}

/** passive geometry never enters the overlay stack or the shell's measured chrome.
 * a card larger than its area scrolls inside it; only a missing area retires it.
 * activating its action closes the card: the action's owner reports what follows.
 */
export default function WorkspaceFeedback({ signals, fallbackFocus }: {
  signals: ReturnType<typeof createTransientFeedback>;
  fallbackFocus?: () => HTMLElement | null;
}) {
  const transient = useSyncExternalStore(signals.subscribe, signals.snapshot, () => null);
  const owner = useInteractionOwner();
  const mobile = useIsMobileViewport();
  const viewport = useMobileViewport();
  const card = useRef<HTMLElement | null>(null);
  const [placed, setPlaced] = useState<object | null>(null);
  const occurrence = transient?.occurrence ?? null;

  useLayoutEffect(() => { signals.environmentChanged(); }, [signals, owner, mobile]);
  useEffect(() => {
    const focusChanged = () => signals.environmentChanged();
    // focus leaving a text field for the body raises no focusin; re-check once it settles.
    const focusLeft = () => queueMicrotask(focusChanged);
    document.addEventListener("focusin", focusChanged);
    document.addEventListener("focusout", focusLeft);
    return () => {
      document.removeEventListener("focusin", focusChanged);
      document.removeEventListener("focusout", focusLeft);
    };
  }, [signals]);
  useLayoutEffect(() => {
    const element = card.current;
    if (!occurrence || !element) return;
    let frame: number | null = null;
    let closed = false;
    const measure = () => {
      frame = null;
      if (closed || signals.snapshot()?.occurrence !== occurrence) return;
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
      if (right <= left || bottom <= top) {
        closed = true;
        signals.closeTransient(occurrence);
        return;
      }
      element.style.maxWidth = `${Math.min(readMobileCssLength("24rem"), right - left)}px`;
      element.style.maxHeight = `${bottom - top}px`;
      const size = element.getBoundingClientRect();
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

  if (!transient || typeof document === "undefined") return null;
  const { content, action } = transient;
  const close = () => signals.closeTransient(transient.occurrence);
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
        close();
      }}>
      <Signal content={content} announcement="None" plain className={styles.transientSignal} occurrence={transient.occurrence}
        actions={action === null ? undefined : [action.href === undefined ? { ...action, onClick: intent => { close(); action.onClick(intent); } } : action]}
        onNavigate={close} onDismiss={close} dismissLabel="close notification" dismissBlocked={false}
        returnFocus={() => { const target = fallbackFocus?.() ?? null; return visible(target) ? target : null; }} />
    </section>
    {placed === occurrence && !owner && transient.announce ? <Announcement text={content.title} level="Polite" occurrence={transient.occurrence} /> : null}
  </div>, document.body);
}
