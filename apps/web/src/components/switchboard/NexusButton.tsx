"use client";

// The mobile Nexus trigger: a tap opens the switchboard inside the gesture; a horizontal
// touch swipe switches to the adjacent pane instead (left: next, right: previous).
import { useLayoutEffect, useRef, type PointerEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import AsterismMark from "@/components/AsterismMark";
import { useMobileChromeSurface } from "@/lib/mobileShell/chrome";
import { useMobileViewport } from "@/lib/mobileShell/viewport";
import type { WorkspaceAdjacentPaneDirection } from "@/lib/workspace/store";
import styles from "@/components/nexus/Nexus.module.css";

const SLOP_PX = 8;
const HORIZONTAL_LOCK_RATIO = 1.5;
const COMMIT_PX = 20;

/** idle, or a press: Tracking until it leaves the slop, then Locked (horizontal) or Yielded. */
type Press = { readonly phase: "Tracking" | "Locked" | "Yielded"; readonly pointerId: number; readonly x: number; readonly y: number } | null;

export default function NexusButton({
  buttonRef,
  paneCount,
  open,
  onOpen,
  onSwipe,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  paneCount: number;
  open: boolean;
  onOpen(): void;
  onSwipe(input: { readonly direction: WorkspaceAdjacentPaneDirection }): void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const press = useRef<Press>(null);
  const suppressClick = useRef(false);
  const mobileViewport = useMobileViewport();
  // The chrome module owns the button's own inert (retreat); the open switchboard inerts the wrapper.
  useMobileChromeSurface(buttonRef, true);
  useLayoutEffect(() => {
    if (!open) return;
    if (press.current) suppressClick.current = true;
    press.current = null;
  }, [open]);
  useLayoutEffect(() => {
    const element = wrapperRef.current;
    if (open || !element) return;
    return mobileViewport.registerBottomSurface("Nexus", element, buttonRef.current);
  }, [mobileViewport, open, buttonRef]);

  const tracked = (event: PointerEvent) => (press.current?.pointerId === event.pointerId ? press.current : null);
  const cancel = (event: PointerEvent) => {
    if (tracked(event)) press.current = null;
  };

  return (
    <div ref={wrapperRef} className={styles.nexusWrapper} inert={open || undefined}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.nexusButton}
        aria-label={paneCount === 1 ? "Open Nexus, 1 pane" : `Open Nexus, ${paneCount} panes`}
        aria-haspopup="dialog"
        data-switchboard-open={open || undefined}
        onPointerDown={(event) => {
          if (press.current) {
            suppressClick.current = true;
            press.current = null;
            return;
          }
          suppressClick.current = false;
          if (!event.isPrimary || event.button !== 0 || open) return;
          // touch compatibility focus can move nexus after capture ends.
          if (event.pointerType === "touch") event.preventDefault();
          press.current = { phase: "Tracking", pointerId: event.pointerId, x: event.clientX, y: event.clientY };
          // keep release on this button when input blur moves its bottom band.
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const current = tracked(event);
          if (current?.phase !== "Tracking") return;
          const dx = event.clientX - current.x;
          const dy = event.clientY - current.y;
          if (Math.hypot(dx, dy) < SLOP_PX) return;
          suppressClick.current = true;
          press.current = { ...current, phase: Math.abs(dx) >= HORIZONTAL_LOCK_RATIO * Math.abs(dy) ? "Locked" : "Yielded" };
        }}
        onPointerUp={(event) => {
          const current = tracked(event);
          if (!current) return;
          press.current = null;
          const dx = event.clientX - current.x;
          // A button the chrome retreated mid-swipe (module-written inert) never commits.
          if (event.pointerType === "touch" && current.phase === "Locked" && Math.abs(dx) >= COMMIT_PX && !open && !event.currentTarget.inert) {
            onSwipe({ direction: dx < 0 ? "Next" : "Previous" });
          }
        }}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
        onClick={(event) => {
          if (event.detail > 0 && suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          flushSync(onOpen);
        }}
      >
        <span className={styles.nexusFace}>
          <AsterismMark className={styles.nexusMark} size={20} />
        </span>
        <span className={styles.nexusCount} aria-hidden="true">
          {paneCount}
        </span>
      </button>
    </div>
  );
}
