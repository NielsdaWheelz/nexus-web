"use client";

import { useCallback, useContext, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { FeedbackRecoveryControl } from "@/components/feedback/Feedback";
import FeedbackSurface from "@/components/feedback/FeedbackSurface";
import MobileSheet from "@/components/ui/MobileSheet";
import type { TargetLinkActivationRuntime } from "@/lib/panes/targetLinkActivation";
import { OverlayContext, useOverlay, wasOverlayInvokedByTouch, type ReturnFocusTarget } from "@/lib/ui/overlay";
import { PlayerFailures } from "./PlayerFailures";
import QueuePanel from "./QueuePanel";
import styles from "./PlayerSheet.module.css";

/**
 * Now playing on phones: the caller's player content, then up next, in one sheet. Opening for
 * the queue reveals and focuses its current entry; opening for the player focuses the disc.
 */
export default function PlayerSheet({ active, target, contentRef, onDismiss, skipReturnFocus, returnFocusTo, returnFocusFallback, announce, runtime, onOpened, children }: {
  readonly active: boolean;
  readonly target: "Player" | "Queue";
  readonly contentRef: Ref<HTMLDivElement>;
  readonly onDismiss: () => void;
  readonly skipReturnFocus: () => boolean;
  readonly returnFocusTo: ReturnFocusTarget;
  readonly returnFocusFallback: ReturnFocusTarget;
  readonly announce: (message: string) => void;
  readonly runtime: TargetLinkActivationRuntime;
  readonly onOpened: () => void;
  readonly children: ReactNode;
}) {
  return <MobileSheet active={active} onDismiss={onDismiss} ariaLabel="now playing" handleLabel="collapse player"
    skipReturnFocus={skipReturnFocus} returnFocusTo={returnFocusTo} returnFocusFallback={returnFocusFallback}
    initialFocus={sheet => {
      const focus = target === "Queue"
        ? sheet.querySelector<HTMLElement>('[data-queue-initial-target="true"] [data-row-focusable]') ?? sheet.querySelector<HTMLHeadingElement>('[aria-label="up next"] h2')
        : sheet.querySelector<HTMLButtonElement>('[data-player-play="true"]') ?? sheet.querySelector<HTMLHeadingElement>("h2");
      if (target === "Player") focus?.scrollIntoView({ block: "start" });
      focus?.focus({ preventScroll: true });
      return focus;
    }}>
    <div ref={contentRef} className={styles.sheetContent} role="region" aria-label="media player">
      {children}
      <QueuePanel announce={announce} scrollport={section => section.parentElement?.parentElement ?? null} runtime={runtime} onOpened={onOpened} revealOnOpen={target === "Queue"} />
    </div>
  </MobileSheet>;
}

/** A playback or chapters panel inside the sheet. Plain content: the overlay kernel owns Escape, Back and focus. */
export function MobileDisclosure({ kind, id, close, trigger, skipReturnFocus, children }: {
  readonly kind: "Playback" | "Chapters";
  readonly id: string;
  readonly close: () => void;
  readonly trigger: () => HTMLElement | null;
  readonly skipReturnFocus: () => boolean;
  readonly children: ReactNode;
}) {
  const region = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<HTMLDivElement | null>(null);
  const modal = useContext(OverlayContext);
  const setRegion = useCallback((element: HTMLDivElement | null) => {region.current = element; setBounds(element);}, []);
  const {layer} = useOverlay(true, { kind: "transient", onDismiss: close, returnFocus: true,
    returnFocusTo: trigger, tabContinuation: () => region.current,
    skipReturnFocus: () => {
      if (skipReturnFocus()) return true;
      const active = document.activeElement;
      return active instanceof HTMLElement && active !== document.body && !region.current?.contains(active);
    },
  });
  useEffect(() => {
    if (wasOverlayInvokedByTouch()) return;
    const panel = region.current;
    const target = kind === "Playback" ? panel?.querySelector<HTMLInputElement>('input[type="range"]')
      : panel?.querySelector<HTMLButtonElement>('button[aria-current="true"]') ?? panel?.querySelector<HTMLButtonElement>('ol button');
    target?.focus({ preventScroll: true });
  }, [kind]);
  return <div ref={setRegion} id={id} role="region" aria-label={kind === "Playback" ? "playback" : "chapters"}>
    <FeedbackSurface bounds={bounds} interaction={layer} modal={modal} active
      protectedTargets={() => [trigger(), bounds?.querySelector<HTMLElement>('input:focus, button:focus') ?? null].filter((element): element is HTMLElement => element !== null)}
      returnFocus={() => trigger() ?? bounds}><FeedbackRecoveryControl />{children}<PlayerFailures /></FeedbackSurface>
  </div>;
}
