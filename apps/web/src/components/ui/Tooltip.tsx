"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEventHandler,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactElement,
  type Ref,
  type RefCallback,
} from "react";
import { createPortal } from "react-dom";
import {
  useOverlay,
  useOverlayContainer,
} from "@/lib/ui/overlay";
import { useAnchoredPosition } from "@/lib/ui/useAnchoredPosition";
import styles from "./Tooltip.module.css";

const CLOSE_DELAY_MS = 150;
// One caption at a time: one that shows closes another still in its grace.
let shownClose: (() => void) | null = null;

type Trigger = HTMLButtonElement | HTMLAnchorElement;

export interface TooltipTriggerProps {
  ref: RefCallback<Trigger>;
  "aria-describedby": string | undefined;
  onPointerEnter: PointerEventHandler<Trigger>;
  onPointerLeave: PointerEventHandler<Trigger>;
  onPointerDown: PointerEventHandler<Trigger>;
  onFocus: FocusEventHandler<Trigger>;
  onBlur: FocusEventHandler<Trigger>;
  onClickCapture: MouseEventHandler<Trigger>;
}

/**
 * Text help for a native button or link; its name, command and state remain
 * the caller's. Pointer hover opens it after `openDelayMs` (500 by default; the
 * collapsed rail's labels open at once), keyboard focus at once; it closes
 * 150 ms after the pointer leaves both trigger and caption, on press, blur,
 * Escape (the overlay kernel), while `disabled` and when another caption shows.
 * `triggerRef` receives the native root; a stable ref stays attached across help
 * changes. Callback cleanup runs once instead of an additional null callback.
 */
export default function Tooltip({
  text,
  renderTrigger,
  placement = "below",
  openDelayMs = 500,
  disabled = false,
  triggerRef,
}: {
  text: string;
  renderTrigger: (props: TooltipTriggerProps) => ReactElement;
  placement?: "below" | "right";
  openDelayMs?: number;
  disabled?: boolean;
  /** The actual native root, composed without discarding React callback cleanup. */
  triggerRef?: Ref<Trigger>;
}) {
  const id = useId();
  const trigger = useRef<Trigger | null>(null);
  const setTrigger = useCallback((node: Trigger | null) => {
    trigger.current = node;
    const cleanup = typeof triggerRef === "function" ? triggerRef(node) : undefined;
    if (triggerRef && typeof triggerRef !== "function") triggerRef.current = node;
    if (node === null) return;
    return () => {
      trigger.current = null;
      if (typeof cleanup === "function") cleanup();
      else if (typeof triggerRef === "function") triggerRef(null);
      else if (triggerRef) triggerRef.current = null;
    };
  }, [triggerRef]);
  const timer = useRef<number | null>(null);
  const pointerTarget = useRef<HTMLElement | null>(null);
  const keyboardFocus = useRef(false);
  const [phase, setPhase] = useState<"Pending" | "Visible" | null>(null);
  const clearTimer = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const close = useCallback(() => {
    clearTimer();
    setPhase(null);
  }, [clearTimer]);
  const position = useAnchoredPosition<HTMLDivElement>(trigger, {
    enabled: phase === "Visible",
    placement,
    align: placement === "right" ? "center" : "end",
    gap: 0,
    flip: placement === "below",
  });
  const { topmost } = useOverlay(phase !== null, {
    kind: "tooltip",
    trigger: () => trigger.current,
    eligible: () => phase === "Visible",
    inside: () => [trigger.current, position.ref.current],
    onDismiss: close,
  });
  const container = useOverlayContainer();
  const visible = phase === "Visible" && topmost && container !== null;

  useLayoutEffect(() => {
    if (phase !== null && (!topmost || disabled)) close();
  }, [phase, topmost, disabled, close]);
  useLayoutEffect(() => {
    if (!visible) return;
    shownClose?.();
    shownClose = close;
    return () => { if (shownClose === close) shownClose = null; };
  }, [visible, close]);
  useEffect(() => {
    if (disabled) return;
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("blur", close);
      clearTimer();
    };
  }, [disabled, close, clearTimer]);

  const leave = () => {
    pointerTarget.current = null;
    clearTimer();
    setPhase((current) => (current === "Pending" ? null : current));
    if (phase === "Visible" && !keyboardFocus.current) {
      timer.current = window.setTimeout(close, CLOSE_DELAY_MS);
    }
  };

  return (
    <>
      {renderTrigger({
        ref: setTrigger,
        "aria-describedby": visible ? id : undefined,
        onPointerEnter: (event) => {
          if (disabled || event.pointerType === "touch" || event.buttons !== 0) return;
          pointerTarget.current = event.currentTarget;
          clearTimer();
          if (phase === "Visible") return;
          setPhase("Pending");
          timer.current = window.setTimeout(() => {
            timer.current = null;
            setPhase("Visible");
          }, openDelayMs);
        },
        onPointerLeave: leave,
        onPointerDown: close,
        onFocus: (event) => {
          keyboardFocus.current = event.currentTarget.matches(":focus-visible");
          if (disabled || !keyboardFocus.current) return;
          clearTimer();
          setPhase("Visible");
        },
        onBlur: () => {
          keyboardFocus.current = false;
          if (!pointerTarget.current?.isConnected) close();
        },
        onClickCapture: close,
      })}
      {visible && container
        ? createPortal(
            <div
              ref={position.ref}
              className={styles.surface}
              data-passive-tooltip="true"
              data-side={position.side}
              style={position.style}
              onPointerEnter={(event) => {
                if (event.pointerType === "touch") return;
                pointerTarget.current = event.currentTarget;
                clearTimer();
              }}
              onPointerLeave={leave}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <div id={id} role="tooltip" className={styles.caption}>
                {text}
              </div>
            </div>,
            container,
          )
        : null}
    </>
  );
}
