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
} from "react";
import { createPortal } from "react-dom";
import {
  hasActiveInteractionOwner,
  useHasActiveInteractionOwner,
  useOverlay,
  useOverlayContainer,
} from "@/lib/ui/overlay";
import { useAnchoredPosition } from "@/lib/ui/useAnchoredPosition";
import styles from "./Tooltip.module.css";

const OPEN_DELAY_MS = 500;
const CLOSE_DELAY_MS = 150;

interface TooltipTriggerProps {
  ref: Ref<HTMLButtonElement>;
  "aria-describedby": string | undefined;
  onPointerEnter: PointerEventHandler<HTMLButtonElement>;
  onPointerLeave: PointerEventHandler<HTMLButtonElement>;
  onPointerDown: PointerEventHandler<HTMLButtonElement>;
  onFocus: FocusEventHandler<HTMLButtonElement>;
  onBlur: FocusEventHandler<HTMLButtonElement>;
  onClickCapture: MouseEventHandler<HTMLButtonElement>;
}

/** Text help for one native button; its command, name and state remain the caller's. */
export default function Tooltip({
  text,
  renderTrigger,
}: {
  text: string;
  renderTrigger: (props: TooltipTriggerProps) => ReactElement;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | null>(null);
  const pointerInside = useRef(false);
  const keyboardFocus = useRef(false);
  const [phase, setPhase] = useState<"Pending" | "Visible" | null>(null);
  const owned = useHasActiveInteractionOwner();
  const clearTimer = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const close = useCallback(() => {
    clearTimer();
    setPhase(null);
  }, [clearTimer]);
  const position = useAnchoredPosition<HTMLDivElement>(trigger, {
    enabled: phase === "Visible" && !owned,
    placement: "below",
    align: "end",
    gap: 0,
    flip: true,
  });
  const { topmost } = useOverlay(phase !== null, {
    kind: "tooltip",
    eligible: () => phase === "Visible",
    inside: () => [trigger.current, position.ref.current],
    onDismiss: close,
  });
  const container = useOverlayContainer();
  const visible = phase === "Visible" && topmost && !owned && container !== null;

  useLayoutEffect(() => {
    if (owned || !topmost) close();
  }, [owned, topmost, close]);
  useEffect(() => {
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("blur", close);
      clearTimer();
    };
  }, [close, clearTimer]);

  const leave = () => {
    pointerInside.current = false;
    clearTimer();
    setPhase((current) => (current === "Pending" ? null : current));
    if (phase === "Visible" && !keyboardFocus.current) {
      timer.current = window.setTimeout(close, CLOSE_DELAY_MS);
    }
  };

  return (
    <>
      {renderTrigger({
        ref: trigger,
        "aria-describedby": visible ? id : undefined,
        onPointerEnter: (event) => {
          if (event.pointerType === "touch" || event.buttons !== 0) return;
          pointerInside.current = true;
          if (hasActiveInteractionOwner() || !topmost) return;
          clearTimer();
          if (phase === "Visible") return;
          setPhase("Pending");
          timer.current = window.setTimeout(() => {
            timer.current = null;
            if (hasActiveInteractionOwner()) close();
            else setPhase("Visible");
          }, OPEN_DELAY_MS);
        },
        onPointerLeave: leave,
        onPointerDown: close,
        onFocus: (event) => {
          keyboardFocus.current = event.currentTarget.matches(":focus-visible");
          if (!keyboardFocus.current || hasActiveInteractionOwner() || !topmost)
            return;
          clearTimer();
          setPhase("Visible");
        },
        onBlur: () => {
          keyboardFocus.current = false;
          if (!pointerInside.current) close();
        },
        onClickCapture: close,
      })}
      {visible && container
        ? createPortal(
            <div
              ref={position.ref}
              className={styles.surface}
              data-side={position.side}
              style={position.style}
              onPointerEnter={(event) => {
                if (event.pointerType === "touch") return;
                pointerInside.current = true;
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
