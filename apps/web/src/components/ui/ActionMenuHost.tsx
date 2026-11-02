"use client";

/**
 * A menu's trigger and the sessions it invokes. The trigger stays mounted; each press begins
 * one session, and only the invoked controller (`ActionMenuInvocation`) owns overlays. A menu
 * holds verbs alone, so what a session could not open is said here, outside it: the host
 * outlives its sessions, owns their one standing report, and retracts it when a menu opens, the
 * subject changes or the host unmounts, so a report's `retry` always prepares the subject it names.
 */
import {
  Fragment,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { useOutcome } from "@/components/feedback/Feedback";
import type { Retract, Verb } from "@/components/feedback/stage";
import { useNavigationIdentity } from "@/lib/host/policy";
import {
  getInteractionGeneration,
  getInteractionOwner,
  wasOverlayInvokedByTouch,
  type Layer,
} from "@/lib/ui/overlay";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import OverflowMenuButton from "./OverflowMenuButton";
import styles from "./ActionMenu.module.css";

const LOAD_FAILED = "couldn’t load actions.";

type TriggerAttributes = Pick<ButtonHTMLAttributes<HTMLButtonElement>, "tabIndex"> &
  Partial<Record<`data-${string}`, string | undefined>>;

/** A custom trigger spreads these onto its focusable button, including busy paint. */
interface ActionMenuTriggerProps extends TriggerAttributes {
  ref: Ref<HTMLButtonElement>;
  type: "button";
  id: string;
  "aria-label": string;
  "aria-describedby": string | undefined;
  "aria-disabled": boolean | undefined;
  "aria-haspopup": "menu" | "dialog";
  "aria-controls": string | undefined;
  "aria-expanded": boolean;
  "aria-busy": boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

/** A native context anchor keeps its own activation, role and accessible name. */
export interface ActionMenuContextAnchorProps {
  ref: (node: HTMLElement | null) => void;
  id: string;
  "aria-haspopup": "menu" | "dialog";
  "aria-controls": string | undefined;
  "aria-expanded": boolean;
  "aria-busy": boolean;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
  onClickCapture: (event: MouseEvent<HTMLElement>) => void;
}

export interface ActionMenuHostProps {
  readonly title: string;
  readonly subjectKey: string;
  readonly label?: string;
  readonly className?: string;
  readonly renderTrigger?: (props: ActionMenuTriggerProps) => ReactNode;
  readonly renderContextAnchor?: (props: ActionMenuContextAnchorProps) => ReactNode;
  readonly triggerAttributes?: TriggerAttributes;
  readonly triggerRef?: (node: HTMLButtonElement | null) => void;
  readonly triggerDisabled?: boolean;
  readonly triggerDisabledReason?: string;
  readonly children: (session: ActionMenuSession) => ReactNode;
}

interface Presentation { readonly visible: boolean; readonly busy: boolean }

export interface ActionMenuSession {
  /** One invocation per session. */
  readonly key: number;
  readonly trigger: RefObject<HTMLElement | null>;
  readonly root: RefObject<HTMLDivElement | null>;
  readonly close: RefObject<(returnFocus?: boolean) => void>;
  readonly menuId: string;
  readonly subjectKey: string;
  readonly title: string;
  readonly mobile: boolean;
  readonly pathname: string | null;
  /** `viewportGeometry()` at the press. */
  readonly viewport: string;
  readonly startedAt: number;
  readonly touch: boolean;
  readonly edge: "first" | "last" | null;
  readonly dismiss: () => void;
  readonly present: (presentation: Presentation) => void;
  /** Preparation failed and no menu opened; `null` is the spent budget, which knows no cause. */
  readonly failed: (error: unknown) => void;
  /** Ready with nothing to offer, so no menu opened. */
  readonly empty: () => void;
  /** The menu opened: an earlier attempt's report no longer holds. */
  readonly opened: () => void;
  /** A new invocation that prepares everything again. */
  readonly reopen: () => void;
}

/** Resize delivery may lag input; compare actual viewport facts at each boundary. */
export function viewportGeometry(): string {
  const visual = window.visualViewport;
  return JSON.stringify([
    window.innerWidth, window.innerHeight,
    visual?.width ?? null, visual?.height ?? null,
    visual?.offsetLeft ?? null, visual?.offsetTop ?? null, visual?.scale ?? null,
  ]);
}

export function ActionMenuHost({ title, subjectKey, label = `more actions for ${title}`, className,
  renderTrigger, renderContextAnchor, triggerAttributes, triggerRef, triggerDisabled = false,
  triggerDisabledReason, children,
}: ActionMenuHostProps) {
  const [state, setState] = useState<{ session: ActionMenuSession | null; presentation: Presentation }>({
    session: null, presentation: { visible: false, busy: false },
  });
  const outcome = useOutcome();
  const local = useRef({
    trigger: { current: null as HTMLElement | null }, root: { current: null as HTMLDivElement | null },
    session: null as ActionMenuSession | null,
    sessions: 0,
    begin: null as ((edge: "first" | "last" | null) => void) | null,
    outcome,
    report: null as Retract | null,
    subjectKey,
    hold: null as { pointer: number; x: number; y: number; timer: ReturnType<typeof setTimeout>; owner: Layer | null; generation: number; subject: string } | null,
    heldClick: false, touchGesture: false, releasePress: null as (() => void) | null,
    cancelHold: null as (() => void) | null,
  }).current;
  local.subjectKey = subjectKey;
  local.outcome = outcome;
  const triggerId = useId();
  const menuId = `${triggerId}-menu`;
  const reasonId = `${triggerId}-reason`;
  const mobile = useIsMobileViewport();
  const pathname = useNavigationIdentity();
  const setTrigger = useCallback((node: HTMLButtonElement | null) => { local.trigger.current = node; triggerRef?.(node); }, [local, triggerRef]);
  local.cancelHold ??= function cancelHold() {
    if (local.hold) clearTimeout(local.hold.timer);
    local.hold = null;
    window.removeEventListener("scroll", cancelHold, true);
    window.removeEventListener("blur", cancelHold);
  };
  const cancelHold = local.cancelHold;
  const consumeHeldClick = (pointer: number) => {
    local.releasePress?.();
    local.heldClick = true;
    const release = () => {
      window.removeEventListener("click", consume, true);
      window.removeEventListener("pointerdown", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("keydown", release, true);
      local.releasePress = null;
      local.heldClick = false;
    };
    const consume = (event: globalThis.MouseEvent) => {
      if (event instanceof globalThis.PointerEvent && event.pointerId > 0 && event.pointerId !== pointer) return;
      release(); event.preventDefault(); event.stopImmediatePropagation();
    };
    local.releasePress = release;
    window.addEventListener("click", consume, true);
    window.addEventListener("pointerdown", release, true);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("keydown", release, true);
  };
  const report = (raise: (() => Retract) | null) => {
    local.report?.();
    local.report = raise?.() ?? null;
  };
  const begin = (edge: "first" | "last" | null) => {
    const dismiss = () => {
      local.session = null;
      setState({ session: null, presentation: { visible: false, busy: false } });
    };
    const retry: Verb = { label: "retry", commandKey: `retry actions ${subjectKey}`, run: () => { if (!local.session) local.begin?.(edge); } };
    const session: ActionMenuSession = {
      key: ++local.sessions,
      trigger: local.trigger, root: local.root, close: { current: dismiss }, menuId, subjectKey, title, mobile, pathname,
      startedAt: performance.now(), viewport: viewportGeometry(), touch: wasOverlayInvokedByTouch(), edge, dismiss,
      present: presentation => setState(value => value.session !== session ||
        value.presentation.visible === presentation.visible && value.presentation.busy === presentation.busy
        ? value : { ...value, presentation }),
      failed: error => report(() => error === null ? local.outcome.say({ fact: LOAD_FAILED }, [retry]) : local.outcome.fail(error, LOAD_FAILED, retry)),
      empty: () => report(() => local.outcome.say({ fact: `no actions for “${title}”.` })),
      opened: () => report(null),
      reopen: () => local.begin?.(null),
    };
    local.session = session;
    setState({ session, presentation: { visible: false, busy: false } });
  };
  local.begin = begin;
  useLayoutEffect(() => () => { cancelHold(); local.releasePress?.(); }, [subjectKey, pathname, cancelHold, local]);
  useLayoutEffect(() => () => { local.report?.(); local.report = null; }, [subjectKey, local]);
  const { visible, busy } = state.presentation;
  const popup = mobile ? "dialog" : "menu";
  const triggerProps: ActionMenuTriggerProps = {
    ...triggerAttributes, ref: setTrigger, type: "button", id: triggerId, "aria-label": label,
    "aria-describedby": triggerDisabled && triggerDisabledReason ? reasonId : undefined,
    "aria-disabled": triggerDisabled || undefined, "aria-haspopup": popup,
    "aria-controls": visible ? menuId : undefined, "aria-expanded": visible, "aria-busy": busy,
    onClick: event => {
      event.stopPropagation();
      if (triggerDisabled) return;
      if (local.session) local.session.close.current(false); else begin(null);
    },
    onKeyDown: event => {
      if (triggerDisabled || event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Tab" && local.session) { local.session.close.current(false); return; }
      if (event.key === "Enter" || event.key === " ") {
        if (event.repeat) event.preventDefault();
        event.stopPropagation();
        return;
      }
      const edge = event.key === "ArrowUp" ? "last" : event.key === "ArrowDown" ? "first" : null;
      if (!edge) return;
      event.preventDefault(); event.stopPropagation();
      if (local.session) local.session.close.current(false); else begin(edge);
    },
  };
  return <div ref={local.root} className={[styles.container, className].filter(Boolean).join(" ")} data-open={visible ? "true" : "false"}>
    {renderContextAnchor ? renderContextAnchor({
      ref: node => { local.trigger.current = node; }, id: triggerId,
      "aria-haspopup": popup, "aria-controls": visible ? menuId : undefined, "aria-expanded": visible, "aria-busy": busy,
      onContextMenu: event => {
        event.preventDefault(); event.stopPropagation();
        const pending = local.hold;
        if (local.touchGesture || event.nativeEvent instanceof globalThis.PointerEvent && event.nativeEvent.pointerType === "touch") {
          if (!pending || pending.owner !== getInteractionOwner() || pending.generation !== getInteractionGeneration() || pending.subject !== local.subjectKey) { cancelHold(); return; }
          consumeHeldClick(pending.pointer);
        }
        cancelHold();
        if (!triggerDisabled && !local.session) begin(null);
      },
      onKeyDown: event => {
        local.touchGesture = false;
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.repeat) return;
        if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
        event.preventDefault(); event.stopPropagation(); cancelHold();
        if (!triggerDisabled && !local.session) begin(null);
      },
      onPointerDown: event => {
        cancelHold(); local.heldClick = false;
        local.touchGesture = event.pointerType === "touch";
        if (triggerDisabled || event.pointerType !== "touch" || !event.isPrimary) return;
        const { pointerId: pointer, clientX: x, clientY: y } = event;
        local.hold = { pointer, x, y, owner: getInteractionOwner(), generation: getInteractionGeneration(), subject: subjectKey,
          timer: setTimeout(() => {
            const pending = local.hold;
            if (!pending || pending.owner !== getInteractionOwner() || pending.generation !== getInteractionGeneration() || pending.subject !== local.subjectKey || !local.trigger.current?.isConnected) { cancelHold(); return; }
            consumeHeldClick(pointer); cancelHold();
            if (!local.session) begin(null);
          }, 500),
        };
        window.addEventListener("scroll", cancelHold, true);
        window.addEventListener("blur", cancelHold);
      },
      onPointerMove: event => {
        const pending = local.hold;
        if (pending && (event.pointerId !== pending.pointer || Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 8)) cancelHold();
      },
      onPointerUp: cancelHold, onPointerCancel: cancelHold,
      onClickCapture: event => { if (local.heldClick) { local.heldClick = false; event.preventDefault(); event.stopPropagation(); } },
    }) : renderTrigger ? renderTrigger(triggerProps) : <OverflowMenuButton {...triggerProps} />}
    {triggerDisabled && triggerDisabledReason ? <span id={reasonId} className="sr-only">{triggerDisabledReason}</span> : null}
    {state.session !== null ? <Fragment key={state.session.key}>{children(state.session)}</Fragment> : null}
  </div>;
}
