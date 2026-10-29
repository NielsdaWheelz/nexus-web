"use client";

import { useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ContextType, type Ref } from "react";
import { useInteractionOwner } from "@/lib/ui/overlay";
import { readMobileCssLength } from "@/lib/mobileShell/viewport";
import { Announcement, ControlledSignal, FailureAnnouncement, Signal } from "./Feedback";
import { Scope, Session } from "./scope";
import styles from "./Feedback.module.css";

/** The host's one passive layer. Cards stack here without positioning themselves. */
export default function FeedbackLayer({ ref }: { ref: Ref<HTMLDivElement> }) {
  const scope = useContext(Scope);
  const session = useContext(Session);
  if (!scope || !session) return <div ref={ref} className={styles.layer} />;
  return <Layer scope={scope} session={session} layerRef={ref} />;
}
function Layer({ scope, session, layerRef }: {
  scope: NonNullable<ContextType<typeof Scope>>;
  session: NonNullable<ContextType<typeof Session>>;
  layerRef: Ref<HTMLDivElement>;
}) {
  const local = useSyncExternalStore(scope.subscribe, scope.snapshot, scope.snapshot);
  const account = useSyncExternalStore(session.account.subscribe, session.account.snapshot, session.account.snapshot);
  const signals = session.transient;
  const transient = useSyncExternalStore(signals.subscribe, signals.snapshot, () => null);
  const interaction = useInteractionOwner();
  const eligible = scope.eligible();
  const allFailures = [...new Map([...local.failures, ...account.failures].map(failure => [failure.occurrence, failure])).values()];
  const failures = allFailures.filter(failure => !scope.recoveryOpen && !session.acknowledged.has(failure.occurrence));
  const [placed, setPlaced] = useState(false);
  const pressed = useRef(false);
  const { host } = scope;
  useLayoutEffect(() => signals.environmentChanged(), [signals, interaction]);
  useEffect(() => {
    const changed = () => signals.environmentChanged();
    document.addEventListener("focusin", changed);
    document.addEventListener("focusout", changed);
    return () => { document.removeEventListener("focusin", changed); document.removeEventListener("focusout", changed); };
  }, [signals]);
  useLayoutEffect(() => {
    const layer = host.layer;
    const bounds = host.bounds;
    if (!layer || !bounds || !eligible || (!failures.length && !transient)) { setPlaced(false); return; }
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const box = bounds.getBoundingClientRect();
      const visual = window.visualViewport;
      const inset = readMobileCssLength("var(--space-3)");
      const left = Math.max(box.left, (visual?.offsetLeft ?? 0) + readMobileCssLength("var(--viewport-safe-left)")) + inset;
      const top = Math.max(box.top, (visual?.offsetTop ?? 0) + readMobileCssLength("var(--viewport-safe-top)")) + inset;
      const right = Math.min(box.right, (visual?.offsetLeft ?? 0) + (visual?.width ?? innerWidth) - readMobileCssLength("var(--viewport-safe-right)")) - inset;
      const bottom = Math.min(box.bottom, (visual?.offsetTop ?? 0) + (visual?.height ?? innerHeight) - readMobileCssLength("var(--viewport-safe-bottom)")) - inset;
      layer.style.maxWidth = `${Math.max(0, Math.min(readMobileCssLength("24rem"), right - left))}px`;
      layer.style.maxHeight = `${Math.max(0, bottom - top)}px`;
      layer.style.left = "0px";
      layer.style.top = "0px";
      const origin = layer.getBoundingClientRect();
      const x = right - origin.width;
      layer.style.left = `${x - origin.left}px`;
      layer.style.top = `${top - origin.top}px`;
      const rectangle = { left: x, top, right, bottom: top + layer.scrollHeight };
      const targets = [...host.protectedTargets(), scope.control, document.activeElement instanceof HTMLElement ? document.activeElement : null];
      const overlaps = targets.some(target => {
        if (!target?.isConnected || layer.contains(target) || scope.disclosure?.contains(target) || [...scope.disclosureTargets].some(element => element.contains(target)) || !target.getClientRects().length) return false;
        const protectedBox = target.getBoundingClientRect();
        return rectangle.left < protectedBox.right && rectangle.right > protectedBox.left && rectangle.top < protectedBox.bottom && rectangle.bottom > protectedBox.top;
      });
      const engaged = pressed.current || layer.contains(document.activeElement)
        || [...scope.disclosureTargets].some(element => element.contains(document.activeElement));
      const fits = right > left && bottom > top && layer.scrollHeight <= bottom - top && !overlaps;
      const visible = engaged || fits;
      setPlaced(visible);
      if (transient) signals.placement(transient.occurrence, visible);
    };
    const schedule = () => { if (frame !== null) cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const release = () => { pressed.current = false; if (transient) signals.hold(transient.occurrence, "Press", false); schedule(); };
    const observer = new ResizeObserver(schedule);
    observer.observe(layer); observer.observe(bounds);
    for (const target of host.protectedTargets()) observer.observe(target);
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    measure();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule); document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("focusin", schedule); document.removeEventListener("focusout", schedule);
      window.visualViewport?.removeEventListener("resize", schedule); window.visualViewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", release);
      if (transient) signals.placement(transient.occurrence, false);
    };
  }, [scope, host, eligible, local, account, transient, signals, failures.length]);
  const close = () => { if (transient) signals.closeTransient(transient.occurrence); };
  return <><div ref={layerRef} className={styles.layer} data-feedback-layer="true" data-placed={eligible && placed || undefined}
    onPointerDown={() => { pressed.current = true; if (transient) signals.hold(transient.occurrence, "Press", true); }}>
    {eligible ? failures.map(failure => <section className={styles.card} key={session.key(failure.occurrence)}>
      <ControlledSignal failure={failure} onDismiss={() => {
        session.acknowledged.set(failure.occurrence, failure.announcementOccurrence ?? failure.occurrence); failure.onDismiss?.(); scope.changed();
      }} />
    </section>) : null}
    {eligible && transient ? <section className={styles.card} key="receipt" aria-label="notification"
      onPointerEnter={event => { if (event.pointerType === "mouse") signals.hold(transient.occurrence, "Pointer", true); }}
      onPointerLeave={() => signals.hold(transient.occurrence, "Pointer", false)}
      onFocus={() => signals.hold(transient.occurrence, "Focus", true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) signals.hold(transient.occurrence, "Focus", false); }}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <Signal content={transient.content} announcement="None" plain className={styles.transientSignal} occurrence={transient.occurrence}
        actions={transient.action === null ? undefined : [transient.action.href === undefined ? { ...transient.action, onClick: intent => { close(); transient.action?.onClick?.(intent); } } : transient.action]}
        onDismiss={close} dismissLabel="close notification" dismissBlocked={false} onNavigate={close} />
      {placed && transient.announce ? <Announcement text={transient.content.title} level="Polite" occurrence={transient.occurrence} /> : null}
    </section> : null}
  </div>
    {eligible ? allFailures.map(failure => <FailureAnnouncement key={session.key(failure.occurrence)} failure={failure} session={session} />) : null}
  </>;
}
