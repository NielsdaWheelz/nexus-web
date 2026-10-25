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
  const local = useRef({
    trigger: { current: null as Trigger | null }, timer: null as number | null,
    pointerTarget: null as HTMLElement | null, keyboardFocus: false,
  }).current;
  const [state, setState] = useState<{ phase: "Pending" | "Visible" | null; visible: boolean }>({ phase: null, visible: false });
  const setTrigger = useCallback((node: Trigger | null) => {
    local.trigger.current = node;
    const cleanup = typeof triggerRef === "function" ? triggerRef(node) : undefined;
    if (triggerRef && typeof triggerRef !== "function") triggerRef.current = node;
    if (node === null) return;
    return () => {
      local.trigger.current = null;
      if (typeof cleanup === "function") cleanup();
      else if (typeof triggerRef === "function") triggerRef(null);
      else if (triggerRef) triggerRef.current = null;
    };
  }, [local, triggerRef]);
  const clearTimer = useCallback(() => {
    if (local.timer !== null) window.clearTimeout(local.timer);
    local.timer = null;
  }, [local]);
  const close = useCallback(() => {
    clearTimer();
    setState(current => current.phase === null && !current.visible ? current : { phase: null, visible: false });
  }, [clearTimer]);
  useLayoutEffect(() => { if (disabled) close(); }, [disabled, close]);
  useEffect(() => clearTimer, [clearTimer]);
  const leave = () => {
    local.pointerTarget = null;
    clearTimer();
    setState(current => current.phase === "Pending" ? { phase: null, visible: false } : current);
    if (state.phase === "Visible" && !local.keyboardFocus) local.timer = window.setTimeout(close, CLOSE_DELAY_MS);
  };
  return <>
    {renderTrigger({
      ref: setTrigger,
      "aria-describedby": state.visible ? id : undefined,
      onPointerEnter: event => {
        if (disabled || event.pointerType === "touch" || event.buttons !== 0) return;
        local.pointerTarget = event.currentTarget;
        clearTimer();
        if (state.phase === "Visible") return;
        setState({ phase: "Pending", visible: false });
        local.timer = window.setTimeout(() => {
          local.timer = null;
          setState({ phase: "Visible", visible: false });
        }, openDelayMs);
      },
      onPointerLeave: leave,
      onPointerDown: close,
      onFocus: event => {
        local.keyboardFocus = event.currentTarget.matches(":focus-visible");
        if (disabled || !local.keyboardFocus) return;
        clearTimer();
        setState({ phase: "Visible", visible: false });
      },
      onBlur: () => { local.keyboardFocus = false; if (!local.pointerTarget?.isConnected) close(); },
      onClickCapture: close,
    })}
    {state.phase !== null ? <TooltipSurface
      id={id} text={text} placement={placement} phase={state.phase} trigger={local.trigger} close={close} leave={leave}
      onPointerEnter={event => {
        if (event.pointerType === "touch") return;
        local.pointerTarget = event.currentTarget; clearTimer();
      }}
      report={visible => setState(current => current.visible === visible ? current : { ...current, visible })}
    /> : null}
  </>;
}

/** Only a pending/visible caption owns overlay subscriptions and positioning. */
function TooltipSurface({ id, text, placement, phase, trigger, close, leave, onPointerEnter, report }: {
  readonly id: string;
  readonly text: string;
  readonly placement: "below" | "right";
  readonly phase: "Pending" | "Visible";
  readonly trigger: { current: Trigger | null };
  readonly close: () => void;
  readonly leave: () => void;
  readonly onPointerEnter: PointerEventHandler<HTMLDivElement>;
  readonly report: (visible: boolean) => void;
}) {
  const position = useAnchoredPosition<HTMLDivElement>(trigger, {
    enabled: phase === "Visible", placement, align: placement === "right" ? "center" : "end", gap: 0, flip: placement === "below",
  });
  const { topmost } = useOverlay(true, {
    kind: "tooltip", trigger: () => trigger.current,
    eligible: () => phase === "Visible", inside: () => [trigger.current, position.ref.current], onDismiss: close,
  });
  const container = useOverlayContainer();
  const visible = phase === "Visible" && topmost && container !== null;
  useLayoutEffect(() => { if (!topmost) close(); }, [topmost, close]);
  useLayoutEffect(() => { report(visible); });
  useLayoutEffect(() => {
    if (!visible) return;
    shownClose?.(); shownClose = close;
    return () => { if (shownClose === close) shownClose = null; };
  }, [visible, close]);
  useEffect(() => {
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, [close]);
  return visible && container ? createPortal(<div
    ref={position.ref} className={styles.surface} data-passive-tooltip="true" data-side={position.side} style={position.style}
    onPointerEnter={onPointerEnter} onPointerLeave={leave}
    onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
  ><div id={id} role="tooltip" className={styles.caption}>{text}</div></div>, container) : null;
}
