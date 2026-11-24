"use client";

// The mobile Nexus trigger: a tap opens the switchboard inside the gesture; a horizontal
// touch swipe switches to the adjacent pane instead (left: next, right: previous) and names
// where it landed for 600ms.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import AsterismMark from "@/components/AsterismMark";
import { useMobileChromeSurface } from "@/lib/mobileShell/chrome";
import { useMobileViewport } from "@/lib/mobileShell/viewport";
import { SWIPE_CHIP_MS } from "@/lib/nexus/policy";
import { suppressDragReleaseClick } from "@/lib/ui/dragGesture";
import type { WorkspaceAdjacentPaneDirection } from "@/lib/workspace/store";
import styles from "./Switchboard.module.css";

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
  /** Switches panes and returns the destination's title, `first pane` / `last pane` at the clamp, or null when it has no title to name. */
  onSwipe(input: { readonly direction: WorkspaceAdjacentPaneDirection }): string | null;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const press = useRef<Press>(null);
  const suppressClick = useRef(false);
  const mobileViewport = useMobileViewport();
  const [chip, setChip] = useState<{ readonly text: string } | null>(null);
  useEffect(() => {
    if (chip === null) return;
    const timer = setTimeout(() => setChip(null), SWIPE_CHIP_MS);
    return () => clearTimeout(timer);
  }, [chip]);
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
    if (!tracked(event)) return;
    press.current = null;
    suppressClick.current = true;
  };

  return (
    <>
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
          if (!event.isPrimary || event.button !== 0 || open || event.currentTarget.inert) return;
          suppressClick.current = false;
          if (event.pointerType === "touch") {
            event.preventDefault();
            // The release can move or open the UI before its compatibility click.
            suppressDragReleaseClick(event.pointerId);
          }
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
          const dy = event.clientY - current.y;
          if (open || event.currentTarget.inert ||
              (current.phase === "Tracking" && Math.hypot(dx, dy) >= SLOP_PX)) {
            suppressClick.current = true;
            return;
          }
          if (event.pointerType !== "touch") return;
          if (current.phase === "Tracking") {
            flushSync(onOpen);
          } else if (current.phase === "Locked" && Math.abs(dx) >= COMMIT_PX) {
            const text = onSwipe({ direction: dx < 0 ? "Next" : "Previous" });
            setChip(text === null ? null : { text });
          }
        }}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
        onClick={(event) => {
          if (event.detail > 0 && suppressClick.current) {
            suppressClick.current = false;
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (!open && !event.currentTarget.inert) flushSync(onOpen);
        }}
      >
        <span className={styles.nexusFace}>
          <AsterismMark className={styles.nexusMark} />
        </span>
        <span className={styles.nexusCount} aria-hidden="true">
          {paneCount}
        </span>
      </button>
    </div>
    <div className={styles.toast} role="status" aria-live="polite">{chip ? <span>{chip.text}</span> : null}</div>
    </>
  );
}
