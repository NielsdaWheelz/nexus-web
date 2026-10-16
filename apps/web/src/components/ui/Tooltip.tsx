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
} from "react";
import { createPortal } from "react-dom";
import {
  useOverlay,
  useOverlayContainer,
} from "@/lib/ui/overlay";
import { useAnchoredPosition } from "@/lib/ui/useAnchoredPosition";
import styles from "./Tooltip.module.css";

const OPEN_DELAY_MS = 500;
const CLOSE_DELAY_MS = 150;

type Trigger = HTMLButtonElement | HTMLAnchorElement;

interface TooltipTriggerProps {
  ref: (node: Trigger | null) => void;
  "aria-describedby": string | undefined;
  onPointerEnter: PointerEventHandler<Trigger>;
  onPointerLeave: PointerEventHandler<Trigger>;
  onPointerDown: PointerEventHandler<Trigger>;
  onFocus: FocusEventHandler<Trigger>;
  onBlur: FocusEventHandler<Trigger>;
  onClickCapture: MouseEventHandler<Trigger>;
}

/** Text help for a native button or link; its name, command and state remain the caller's. */
export default function Tooltip({
  text,
  renderTrigger,
}: {
  text: string;
  renderTrigger: (props: TooltipTriggerProps) => ReactElement;
}) {
  const id = useId();
  const trigger = useRef<Trigger | null>(null);
  const setTrigger = useCallback((node: Trigger | null) => { trigger.current = node; }, []);
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
    placement: "below",
    align: "end",
    gap: 0,
    flip: true,
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
    if (phase !== null && !topmost) close();
  }, [phase, topmost, close]);
  useEffect(() => {
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("blur", close);
      clearTimer();
    };
  }, [close, clearTimer]);

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
          if (event.pointerType === "touch" || event.buttons !== 0) return;
          pointerTarget.current = event.currentTarget;
          clearTimer();
          if (phase === "Visible") return;
          setPhase("Pending");
          timer.current = window.setTimeout(() => {
            timer.current = null;
            setPhase("Visible");
          }, OPEN_DELAY_MS);
        },
        onPointerLeave: leave,
        onPointerDown: close,
        onFocus: (event) => {
          keyboardFocus.current = event.currentTarget.matches(":focus-visible");
          if (!keyboardFocus.current) return;
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
