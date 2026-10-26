"use client";

import {
  Fragment,
  useCallback,
  useEffect,
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
import { createPortal, flushSync } from "react-dom";
import { useNavigationIdentity } from "@/lib/host/policy";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import { useMobileChromeHold } from "@/lib/mobileShell/chrome";
import {
  prepareActionSelect,
  projectActionControlState,
  type MenuContent,
  type MenuOption,
  type MenuSource,
} from "@/lib/ui/actionDescriptor";
import { isEditableTarget } from "@/lib/ui/eventTarget";
import {
  focusableElements,
  getInteractionOwner,
  getInteractionGeneration,
  handleModalTab,
  restoreFocus,
  useInteractionOwner,
  useOverlay,
  useOverlayContainer,
  wasOverlayInvokedByTouch,
  type Layer,
  type ReturnFocusTarget,
} from "@/lib/ui/overlay";
import { useAnchoredPosition } from "@/lib/ui/useAnchoredPosition";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useIndexRowWindow } from "@/lib/collections/indexRowWindow";
import MobileSheet from "./MobileSheet";
import OverflowMenuButton from "./OverflowMenuButton";
import RadioGroup from "./RadioGroup";
import styles from "./ActionMenu.module.css";
import choiceField from "./ChoiceField.module.css";
import collection from "./Collection.module.css";

const PREPARATION_BUDGET_MS = 5000;
const TRAILING_INDEX = 10_000;
// Moving focus into a sheet can dismiss the IME. Admit after its geometry quiets;
// there is no portable keyboard-transition completion event.
const MOBILE_ADMISSION_QUIET_MS = 150;
const ITEMS = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';
const FAILED: FeedbackContent = { tone: "Warning", title: "actions couldn’t load" };

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

type Attempt = {
  readonly controller: AbortController;
  readonly expires: number;
  timer: ReturnType<typeof setTimeout> | null;
};
type Invocation = {
  readonly subject: string;
  readonly title: string;
  readonly mobile: boolean;
  readonly pathname: string | null;
  readonly viewport: string;
  readonly edge: "first" | "last";
  readonly touch: boolean;
  readonly attempt: Attempt | null;
  readonly visible: boolean;
  readonly feedback: FeedbackContent | null;
  readonly meaning: string | null;
  readonly geometry: readonly number[] | null;
  readonly admission: { phase: "Focus" | "Settling" | "Ready"; timer: ReturnType<typeof setTimeout> | null } | null;
  readonly side: "above" | "below" | null;
};

/** Displayed meaning excludes closures, availability and a choice's live value;
 *  execution reads current descriptors. */
function meaning(title: string, content: MenuContent): string {
  return JSON.stringify([title, content.sections.map((section) => [
    section.id, section.label, section.options.map((option) => {
      if (option.kind === "choice") return [
        option.id, option.kind, option.label, option.choices.map((entry) => [entry.value, entry.label]),
        option.disabledReason, option.separatorBefore,
      ];
      const state = option.kind === "command" ? option.state : undefined;
      return [
        option.id, option.kind, option.label, option.href, option.tone,
        option.disabledReason, option.separatorBefore,
        state?.kind === "toggle" ? [state.kind, state.pressed] : state ?
          [state.kind, state.expanded, state.controls, state.menuLabels.collapsed, state.menuLabels.expanded] : null,
      ];
    }),
  ])]);
}

/** Resize delivery may lag input; compare actual viewport facts at each boundary. */
function viewportGeometry(): string {
  const visual = window.visualViewport;
  return JSON.stringify([
    window.innerWidth, window.innerHeight,
    visual?.width ?? null, visual?.height ?? null,
    visual?.offsetLeft ?? null, visual?.offsetTop ?? null, visual?.scale ?? null,
  ]);
}

/** The trailing region may change after publication; only published rows define geometry. */
function geometry(anchor: HTMLElement, body: HTMLElement, mobile: boolean, published: boolean): readonly number[] {
  const panel = mobile ? body.closest<HTMLElement>('[role="dialog"]') ?? body : body;
  const box = panel.getBoundingClientRect();
  let panelX = box.x;
  let panelY = box.y;
  if (mobile) {
    // MobileSheet's fixed, untransformed backdrop is its offset parent. Layout
    // offsets ignore the sheet's translation without mixing compositor samples.
    const parent = panel.offsetParent;
    if (!parent) throw new Error("mobile action sheet requires its layout containing block");
    const origin = parent.getBoundingClientRect();
    panelX = origin.left + parent.clientLeft + panel.offsetLeft - parent.scrollLeft;
    panelY = origin.top + parent.clientTop + panel.offsetTop - parent.scrollTop;
  }
  const position = anchor.getBoundingClientRect();
  const rows = [...body.querySelectorAll<HTMLElement>(published ? "[data-menu-published] [data-menu-row]" : "[data-menu-row]")].map((row) => {
    const rect = row.getBoundingClientRect();
    let x = rect.left - box.left;
    let y = rect.top - box.top;
    for (let parent = row.parentElement; parent; parent = parent.parentElement) {
      x += parent.scrollLeft;
      y += parent.scrollTop;
      if (parent === panel) break;
    }
    return published ? [panelX + x, panelY + y, rect.width, rect.height] : [x, y, rect.width, rect.height];
  });
  return published ? [position.x, position.y, position.width, position.height, ...rows.flat()] : [
    position.x, position.y, position.width, position.height,
    panelX, panelY, box.width, box.height,
    ...rows.flat(),
  ];
}

function trailingRoom(scroller: HTMLElement, mobile: boolean): number {
  const published = scroller.querySelector<HTMLElement>(":scope > [data-menu-published]");
  if (!published) throw new Error("a trailing menu requires its published content block");
  const style = getComputedStyle(scroller);
  const used = published.getBoundingClientRect().height
    + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  if (!mobile) return parseFloat(style.maxBlockSize) - used;
  const panel = scroller.closest<HTMLElement>('[role="dialog"]');
  const parent = panel?.parentElement;
  if (!panel || !parent) throw new Error("a mobile trailing menu requires its sheet containing block");
  const containing = getComputedStyle(parent);
  const available = parent.getBoundingClientRect().height
    - parseFloat(containing.paddingTop) - parseFloat(containing.paddingBottom)
    - parseFloat(containing.borderTopWidth) - parseFloat(containing.borderBottomWidth);
  return available - (panel.getBoundingClientRect().height - scroller.getBoundingClientRect().height) - used;
}

/**
 * One invocation owns preparation, publication and dismissal. Initial preparation
 * has one hidden transient; publication has one desktop transient or mobile frame.
 * A complete measured result must beat its activation-time deadline. Published
 * meaning and geometry are immutable; callbacks and availability remain current.
 */
export interface ActionMenuProps {
  readonly source: MenuSource;
  readonly label?: string;
  readonly className?: string;
  /** Reports actual visibility only; it never starts preparation. */
  readonly onOpenChange?: (open: boolean) => void;
  readonly placement?: "below" | "above";
  readonly align?: "start" | "center" | "end";
  readonly renderTrigger?: (props: ActionMenuTriggerProps) => ReactNode;
  readonly renderContextAnchor?: (props: ActionMenuContextAnchorProps) => ReactNode;
  readonly triggerAttributes?: TriggerAttributes;
  readonly triggerRef?: (node: HTMLButtonElement | null) => void;
  readonly returnFocusTo?: ReturnFocusTarget;
  readonly triggerDisabled?: boolean;
  readonly triggerDisabledReason?: string;
}
interface Presentation { readonly visible: boolean; readonly busy: boolean; readonly popup: "menu" | "dialog" }
export interface ActionMenuSession {
  readonly trigger: RefObject<HTMLElement | null>;
  readonly root: RefObject<HTMLDivElement | null>;
  readonly close: RefObject<(returnFocus?: boolean) => void>;
  readonly menuId: string;
  readonly subjectKey: string;
  readonly title: string;
  readonly mobile: boolean;
  readonly pathname: string | null;
  readonly viewport: string;
  readonly startedAt: number;
  readonly touch: boolean;
  readonly edge: "first" | "last";
  readonly dismiss: () => void;
  readonly announce: (message: string) => void;
  readonly present: (presentation: Presentation) => void;
}

/** A menu's real trigger stays mounted; only an invoked controller owns overlays. */
export function ActionMenuHost({ title, subjectKey, label = `more actions for ${title}`, className,
  renderTrigger, renderContextAnchor, triggerAttributes, triggerRef, triggerDisabled = false,
  triggerDisabledReason, children,
}: Omit<ActionMenuProps, "source"> & {
  readonly title: string;
  readonly subjectKey: string;
  readonly children: (session: ActionMenuSession) => ReactNode;
}) {
  const [state, setState] = useState<{ session: ActionMenuSession | null; presentation: Presentation; announcement: string }>({
    session: null, presentation: { visible: false, busy: false, popup: "menu" }, announcement: "",
  });
  const local = useRef({
    trigger: { current: null as HTMLElement | null }, root: { current: null as HTMLDivElement | null },
    session: null as ActionMenuSession | null,
    subjectKey,
    hold: null as { pointer: number; x: number; y: number; timer: ReturnType<typeof setTimeout>; owner: Layer | null; generation: number; subject: string } | null,
    heldClick: false, touchGesture: false, releasePress: null as (() => void) | null,
    cancelHold: null as (() => void) | null,
  }).current;
  local.subjectKey = subjectKey;
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
  const begin = (edge: "first" | "last") => {
    const dismiss = () => {
      local.session = null;
      setState(value => ({ ...value, session: null, presentation: { visible: false, busy: false, popup: "menu" } }));
    };
    const session: ActionMenuSession = {
      trigger: local.trigger, root: local.root, close: { current: dismiss }, menuId, subjectKey, title, mobile, pathname,
      startedAt: performance.now(), viewport: viewportGeometry(), touch: wasOverlayInvokedByTouch(), edge, dismiss,
      announce: announcement => setState(value => value.announcement === announcement ? value : { ...value, announcement }),
      present: presentation => setState(value => value.session !== session ||
        value.presentation.visible === presentation.visible && value.presentation.busy === presentation.busy && value.presentation.popup === presentation.popup
        ? value : { ...value, presentation }),
    };
    local.session = session;
    setState({ session, presentation: { visible: false, busy: false, popup: mobile ? "dialog" : "menu" }, announcement: "" });
  };
  useLayoutEffect(() => () => { cancelHold(); local.releasePress?.(); }, [subjectKey, pathname, cancelHold, local]);
  const { visible, busy } = state.presentation;
  const popup = mobile ? "dialog" : state.presentation.popup;
  const triggerProps: ActionMenuTriggerProps = {
    ...triggerAttributes, ref: setTrigger, type: "button", id: triggerId, "aria-label": label,
    "aria-describedby": triggerDisabled && triggerDisabledReason ? reasonId : undefined,
    "aria-disabled": triggerDisabled || undefined, "aria-haspopup": popup,
    "aria-controls": visible ? menuId : undefined, "aria-expanded": visible, "aria-busy": busy,
    onClick: event => {
      event.stopPropagation();
      if (triggerDisabled) return;
      if (local.session) local.session.close.current(false); else begin("first");
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
        if (!triggerDisabled && !local.session) begin("first");
      },
      onKeyDown: event => {
        local.touchGesture = false;
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.repeat) return;
        if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
        event.preventDefault(); event.stopPropagation(); cancelHold();
        if (!triggerDisabled && !local.session) begin("first");
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
            if (!local.session) begin("first");
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
    {state.session !== null || state.announcement ? <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">{state.announcement}</span> : null}
    {state.session !== null ? children(state.session) : null}
  </div>;
}

export default function ActionMenu({ source, ...props }: ActionMenuProps) {
  return <ActionMenuHost {...props} title={source.title} subjectKey={source.subjectKey}>{session =>
    <ActionMenuInvocation source={source} session={session} placement={props.placement} align={props.align} onOpenChange={props.onOpenChange} returnFocusTo={props.returnFocusTo} />
  }</ActionMenuHost>;
}

/** Active-only preparation, measurement, overlay admission and menu execution. */
export function ActionMenuInvocation({ source, session, placement = "below", align = "end", onOpenChange, returnFocusTo }: {
  readonly source: MenuSource;
  readonly session: ActionMenuSession;
  readonly placement?: "below" | "above";
  readonly align?: "start" | "center" | "end";
  readonly onOpenChange?: (open: boolean) => void;
  readonly returnFocusTo?: ReturnFocusTarget;
}) {
  const rowWindow = useIndexRowWindow();
  useLayoutEffect(() => {
    rowWindow?.interact();
    return rowWindow?.pin();
  }, [rowWindow]);
  const [invocation, setInvocation] = useState<Invocation | null>(null);
  const current = useRef(invocation);
  const latest = useRef(source);
  latest.current = source;
  const { trigger, root, menuId, announce } = session;
  const sheetBody = useRef<HTMLDivElement>(null);
  const modalLayer = useRef<Layer | null>(null);
  const skipReturn = useRef(false);
  const releasePress = useRef<(() => void) | null>(null);
  const container = useOverlayContainer();
  const mobile = useIsMobileViewport();
  const pathname = useNavigationIdentity();
  useInteractionOwner();
  const prepared = source.kind === "Prepared" && invocation?.attempt &&
    !invocation.attempt.controller.signal.aborted &&
    source.state?.request === invocation.attempt.controller.signal ? source.state : null;
  const trailingRegion = source.kind === "Prepared" && source.trailing !== undefined;
  const trailing = trailingRegion && invocation?.attempt && !invocation.attempt.controller.signal.aborted &&
    source.trailing?.request === invocation.attempt.controller.signal ? source.trailing ?? null : null;
  const content = invocation && (source.kind === "Immediate" ? source.content :
    prepared?.kind === "Ready" ? prepared.content : null);
  const feedback = invocation?.feedback ?? null;
  const hasOptions = content?.sections.some((section) => section.options.length > 0) ?? false;
  const requested = invocation !== null;
  const candidate = invocation !== null && (content !== null || feedback !== null);
  const sheet = candidate && invocation?.mobile === true;
  const visible = invocation?.visible === true && invocation.admission === null;
  const busy = invocation?.attempt?.timer != null;
  useMobileChromeHold(invocation !== null);
  const lockedSide = trailingRegion ? invocation?.side ?? null : null;
  const menu = useAnchoredPosition<HTMLDivElement>(trigger, {
    enabled: candidate && !sheet && container !== null,
    placement: lockedSide ?? placement, align, flip: lockedSide === null, keepAnchorVisible: true,
  });
  const surface = () => current.current?.mobile ? sheetBody.current : menu.ref.current;
  const closeRef = useRef<(returnFocus?: boolean) => void>(() => undefined);
  const { layer } = useOverlay(invocation !== null && !sheet, {
    kind: "transient",
    dismissOnNavigation: true,
    onDismiss: (reason) => closeRef.current(reason !== "outside" && reason !== "tab" && reason !== "navigation"),
    inside: () => [menu.ref.current, root.current],
    returnFocusTo: () => returnFocusTo?.() ?? trigger.current,
  });
  const change = (next: Invocation | null) => {
    current.current = next;
    setInvocation(next);
    if (next === null) session.dismiss();
  };
  const close = (returnFocus = true) => {
    const active = current.current;
    if (!active) return;
    if (active.attempt?.timer) clearTimeout(active.attempt.timer);
    if (active.admission?.timer) clearTimeout(active.admission.timer);
    skipReturn.current = true;
    if (returnFocus) restoreFocus(active.mobile && modalLayer.current ? modalLayer.current : layer);
    change(null);
    active.attempt?.controller.abort();
  };
  closeRef.current = close;
  session.close.current = close;
  const fail = (attempt: Attempt, failure: FeedbackContent) => {
    const active = current.current;
    if (!active || active.attempt !== attempt) return;
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.timer = null;
    change({ ...active, attempt: null, feedback: failure, meaning: null, geometry: null });
    attempt.controller.abort();
    announce("actions couldn’t load");
  };
  const begin = (edge: "first" | "last", retry = false) => {
    const previous = current.current;
    if (retry && (!previous || previous.subject !== source.subjectKey || source.kind !== "Prepared")) return;
    if (previous?.admission?.timer) clearTimeout(previous.admission.timer);
    const now = retry ? performance.now() : session.startedAt;
    const attempt: Attempt | null = source.kind === "Prepared" ? {
      controller: new AbortController(), expires: now + PREPARATION_BUDGET_MS, timer: null,
    } : null;
    skipReturn.current = false;
    change({
      subject: session.subjectKey, title: session.title, mobile: session.mobile, pathname: session.pathname, edge,
      viewport: retry ? viewportGeometry() : session.viewport,
      touch: retry ? false : session.touch,
      attempt, visible: retry, feedback: retry ? previous?.feedback ?? null : null,
      meaning: null, geometry: null, side: null,
      admission: mobile ? { phase: "Focus", timer: null } : null,
    });
    if (attempt && source.kind === "Prepared") {
      attempt.timer = setTimeout(() => fail(attempt, FAILED), Math.max(0, attempt.expires - performance.now()));
      announce("loading actions…");
      source.prepare(attempt.controller.signal);
    } else announce("");
  };
  useLayoutEffect(() => {
    begin(session.edge);
    // An invocation owns its activation deadline; strict replay reacquires it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);
  useLayoutEffect(() => {
    session.present({ visible, busy, popup: mobile || (candidate && !hasOptions) ? "dialog" : "menu" });
  });
  const invalidate = () => {
    if (!current.current) return;
    close(true);
    announce("actions changed. reopen to see current options.");
  };
  const settleMobile = () => {
    const active = current.current;
    const admission = active?.admission;
    if (!active || !admission || admission.phase === "Focus") return;
    if (admission.timer) clearTimeout(admission.timer);
    admission.phase = "Settling";
    admission.timer = setTimeout(() => {
      admission.timer = null;
      if (current.current?.admission !== admission) return;
      admission.phase = "Ready";
      checks.current.publish();
    }, MOBILE_ADMISSION_QUIET_MS);
  };
  const stable = () => {
    const active = current.current;
    const node = surface();
    if (!active || active.admission !== null || !trigger.current?.isConnected || !trigger.current.getClientRects().length) return false;
    if (active.subject !== latest.current.subjectKey || active.title !== latest.current.title ||
      active.viewport !== viewportGeometry()) return false;
    if (active.meaning === null) return true;
    const value = latest.current;
    const ready = value.kind === "Immediate" ? value.content :
      value.state?.kind === "Ready" && value.state.request === active.attempt?.controller.signal
        ? value.state.content : null;
    if (ready === null || active.meaning !== meaning(value.title, ready) ||
      node === null || active.geometry === null) return false;
    const measured = geometry(trigger.current, node, active.mobile, trailingRegion);
    // Compositor/transform serialization noise can cross rounding boundaries.
    // Compare at 1/64 CSS px precision against the fixed publication snapshot.
    return active.geometry.length === measured.length && active.geometry.every(
      (coordinate, index) => Math.abs(coordinate - measured[index]) <= 1 / 64,
    );
  };
  // Render-induced changes retire before paint. Readiness alone cannot publish:
  // the complete host must be measured and still inside this attempt's budget.
  const publish = () => {
    const active = current.current;
    // Initial begin schedules the admitted render; its ref alone cannot publish
    // through the preceding commit, whose overlay is still closed.
    if (invocation === null || !active) return;
    if (active.subject !== source.subjectKey || active.mobile !== mobile || active.pathname !== pathname) {
      closeRef.current(false);
      return;
    }
    if (active.admission === null && active.viewport !== viewportGeometry()) {
      if (active.visible) invalidate(); else closeRef.current(false);
      return;
    }
    if (active.title !== source.title) {
      if (active.visible) invalidate(); else closeRef.current(false);
      return;
    }
    if (!trigger.current?.isConnected || !trigger.current.getClientRects().length) {
      closeRef.current(false);
      return;
    }
    const admitted = getInteractionOwner();
    if (admitted !== layer && admitted !== modalLayer.current) {
      closeRef.current(false);
      return;
    }
    if (active.admission !== null && active.admission.phase !== "Ready") return;
    if (active.meaning !== null) {
      if (!stable()) invalidate();
      return;
    }
    if (prepared?.kind === "Failed" && active.attempt) {
      fail(active.attempt, prepared.feedback);
      return;
    }
    if (!candidate || (!sheet && !menu.placed)) return;
    const node = surface();
    if (!node || !trigger.current) return;
    if (content && active.attempt && performance.now() >= active.attempt.expires) {
      fail(active.attempt, FAILED);
      return;
    }
    if (content && trailingRegion && !active.mobile && active.side === null) {
      const placed = node.getBoundingClientRect().bottom <= trigger.current.getBoundingClientRect().top + 1 ? "above" : "below";
      change({ ...active, side: placed });
      return;
    }
    if (content && active.attempt?.timer) {
      clearTimeout(active.attempt.timer);
      active.attempt.timer = null;
    }
    if (content && trailingRegion) {
      const region = node.querySelector<HTMLElement>("[data-menu-trailing]");
      const room = region ? trailingRoom(node, active.mobile) : NaN;
      if (region && Number.isFinite(room)) region.style.maxBlockSize = `${Math.max(region.getBoundingClientRect().height, room)}px`;
    }
    if (content || !active.visible || active.admission !== null) {
      change({
        ...active, visible: true, feedback: content ? null : active.feedback,
        viewport: viewportGeometry(), admission: null,
        meaning: content ? meaning(source.title, content) : null,
        geometry: content ? geometry(trigger.current, node, active.mobile, trailingRegion) : null,
      });
      if (content && !hasOptions) announce("no actions available");
      else if (content) announce("");
    }
  };
  const checks = useRef({ stable, invalidate, close, surface, publish, settleMobile });
  checks.current = { stable, invalidate, close, surface, publish, settleMobile };
  // Source and invocation are read after every commit; callback identity is not
  // a lifecycle boundary or permission to publish.
  useLayoutEffect(() => { checks.current.publish(); });

  // Capture checks precede custom handlers and native/shifted/auxiliary defaults.
  useLayoutEffect(() => {
    if (!requested) return;
    const press = (event: PointerEvent) => {
      releasePress.current?.();
      if (!current.current?.visible || current.current.admission !== null || checks.current.stable()) return;
      const { pointerId, button } = event;
      // A moved menu can leave the old coordinate outside its surface. Consume
      // that press before the kernel, then keep only its delivery listeners
      // through close. Delivery, cancellation or the next gesture releases them.
      const release = () => {
        window.removeEventListener("click", delivery, true);
        window.removeEventListener("auxclick", delivery, true);
        window.removeEventListener("pointercancel", cancel, true);
        window.removeEventListener("pointerdown", release, true);
        window.removeEventListener("keydown", release, true);
        releasePress.current = null;
      };
      const delivery = (delivered: globalThis.MouseEvent) => {
        release();
        if (delivered.button !== button ||
          (delivered instanceof PointerEvent && delivered.pointerId > 0 && delivered.pointerId !== pointerId)) return;
        delivered.preventDefault();
        delivered.stopImmediatePropagation();
      };
      const cancel = (cancelled: PointerEvent) => {
        if (cancelled.pointerId === pointerId) release();
      };
      releasePress.current = release;
      window.addEventListener("click", delivery, true);
      window.addEventListener("auxclick", delivery, true);
      window.addEventListener("pointercancel", cancel, true);
      window.addEventListener("pointerdown", release, true);
      window.addEventListener("keydown", release, true);
      event.preventDefault();
      event.stopImmediatePropagation();
      checks.current.invalidate();
    };
    const guard = (event: Event) => {
      const node = checks.current.surface();
      if (!(event.target instanceof Node) || !node?.contains(event.target)) return;
      if (event instanceof globalThis.KeyboardEvent && !["Enter", " "].includes(event.key)) return;
      if (checks.current.stable()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      checks.current.invalidate();
    };
    const departure = (event: FocusEvent) => {
      const active = current.current;
      if (active?.admission?.phase === "Focus" && event.target instanceof Node && modalLayer.current?.element?.contains(event.target)) {
        active.admission.phase = "Settling";
        checks.current.settleMobile();
      }
      const node = checks.current.surface();
      if (event.target instanceof Node && !root.current?.contains(event.target) && !node?.contains(event.target)
        && !modalLayer.current?.element?.contains(event.target)) checks.current.close(false);
    };
    const resize = () => {
      if (current.current?.admission) { checks.current.settleMobile(); return; }
      if (current.current?.visible) checks.current.invalidate(); else checks.current.close(false);
    };
    const retire = () => checks.current.close(false);
    const scroll = (event: Event) => {
      const node = checks.current.surface();
      if (event.target instanceof Node && node?.contains(event.target)) return;
      if (current.current?.mobile && event.target instanceof Node && modalLayer.current?.element?.contains(event.target)) return;
      if (current.current?.admission) { checks.current.settleMobile(); return; }
      if (!checks.current.stable()) checks.current.invalidate();
    };
    const observer = new ResizeObserver(() => {
      if (current.current?.admission) { checks.current.settleMobile(); return; }
      if (!checks.current.stable()) checks.current.invalidate();
    });
    if (trigger.current) observer.observe(trigger.current);
    const node = checks.current.surface();
    if (node) {
      observer.observe(node);
      for (const row of node.querySelectorAll("[data-menu-row]")) observer.observe(row);
    }
    window.addEventListener("pointerdown", press, true);
    document.addEventListener("click", guard, true);
    document.addEventListener("auxclick", guard, true);
    document.addEventListener("keydown", guard, true);
    document.addEventListener("focusin", departure, true);
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    window.addEventListener("blur", retire);
    window.addEventListener("scroll", scroll, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("pointerdown", press, true);
      document.removeEventListener("click", guard, true);
      document.removeEventListener("auxclick", guard, true);
      document.removeEventListener("keydown", guard, true);
      document.removeEventListener("focusin", departure, true);
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      window.removeEventListener("blur", retire);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [requested, visible, sheet, root, trigger]);
  useLayoutEffect(() => () => {
    releasePress.current?.();
    const active = current.current;
    if (active?.attempt?.timer) clearTimeout(active.attempt.timer);
    if (active?.admission?.timer) clearTimeout(active.admission.timer);
    active?.attempt?.controller.abort();
  }, []);
  const report = useRef(onOpenChange);
  report.current = onOpenChange;
  useEffect(() => {
    if (!visible) return;
    report.current?.(true);
    return () => report.current?.(false);
  }, [visible]);
  const focusKey = invocation?.admission ?? invocation?.meaning ?? invocation?.feedback;
  // Ready focus precedes the removed failure notice's deferred return focus.
  // Initial content stays hidden until its measured publication commits.
  useLayoutEffect(() => {
    if (!visible || sheet || !current.current) return;
    const node = menu.ref.current;
    if (!node) return;
    const items = [...node.querySelectorAll<HTMLElement>(ITEMS)];
    const controls = items.length ? items : focusableElements(node);
    (controls[current.current.edge === "last" ? controls.length - 1 : 0] ?? node).focus();
  }, [visible, sheet, focusKey, menu.ref]);

  const onSurfaceKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 ||
      event.altKey || event.ctrlKey || event.metaKey || isEditableTarget(event.target)) return;
    if (event.repeat && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const onSurfaceKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (sheet) {
      if (event.key === "Tab") handleModalTab(event);
      return;
    }
    if (event.key === "Tab") {
      event.currentTarget.inert = true;
      const candidates = [layer.options.current.returnFocusTo?.(), layer.opener,
        layer.options.current.returnFocusFallback?.(), layer.parent?.element];
      for (const candidate of candidates) {
        const target = candidate instanceof HTMLElement ? candidate : candidate?.element;
        if (!target?.isConnected || target.closest("[hidden], [inert]")) continue;
        target.focus({ preventScroll: true });
        if (document.activeElement === target) break;
      }
      close(false);
      handleModalTab(event);
      return;
    }
    if (isEditableTarget(event.target)) return;
    const active = document.activeElement;
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && active?.matches('[role="menuitemradio"]')) {
      const radios = [...(active.closest("[data-menu-row]")?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
      const index = radios.findIndex((radio) => radio === active) + (event.key === "ArrowRight" ? 1 : -1);
      event.preventDefault();
      radios[(index + radios.length) % radios.length]?.focus();
      return;
    }
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(ITEMS)];
    if (!items.length) return;
    const at = items.findIndex((item) => item === active);
    const go = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus();
    };
    if (event.key === "ArrowDown") go(at < 0 ? 0 : at + 1);
    else if (event.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(-1);
    else if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const ordered = [...items.slice(at + 1), ...items.slice(0, at + 1)];
      const next = ordered.find((item) => item.textContent?.trim().toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()));
      if (next) go(items.indexOf(next));
    }
  };

  const latestOption = (id: string) => {
    const value = latest.current;
    const ready = value.kind === "Immediate" ? value.content : value.state?.kind === "Ready" ? value.state.content : null;
    const later = value.kind === "Prepared" && value.state?.kind === "Ready" && value.trailing?.kind === "Ready" &&
      value.trailing.request === value.state.request ? value.trailing.options : [];
    return [...ready?.sections.flatMap((section) => section.options) ?? [], ...later].find((entry) => entry.id === id);
  };
  const item = (option: MenuOption, index: number) => {
    if (option.kind === "choice") {
      if (sheet) return <li key={option.id}>
        <div data-menu-row={option.id} className={styles.choiceRow}>
          <RadioGroup label={option.label} value={option.value} choices={option.choices} onChange={option.onChange}
            presentation="Segmented" legend="Hidden" description={option.disabled ? option.disabledReason : undefined}
            disabled={option.disabled} />
        </div>
      </li>;
      const reason = option.disabled && option.disabledReason ? `${menuId}-reason-${index}` : undefined;
      const choose = (value: string, closing: boolean) => {
        const choice = latestOption(option.id);
        if (choice?.kind !== "choice" || !checks.current.stable()) {
          invalidate();
          return false;
        }
        if (choice.disabled) return false;
        // Enter closes first, so focus is home before the value changes.
        if (closing) flushSync(() => close(true));
        if (choice.value !== value) choice.onChange(value);
        return true;
      };
      return <li role="none" key={option.id}>
        <div role="group" aria-label={option.label} data-menu-row={option.id}
          data-action-availability={option.disabled ? "Blocked" : "Available"} className={styles.choiceRow}>
          <div className={choiceField.segments}>
            {option.choices.map((entry) => <button key={entry.value} type="button" role="menuitemradio"
              aria-checked={entry.value === option.value} tabIndex={-1} data-action-id={`${option.id}.${entry.value}`}
              className={choiceField.segment} aria-disabled={option.disabled || undefined} aria-describedby={reason}
              // Click and Space's native click choose and keep the menu open.
              onClick={(event) => {
                event.stopPropagation();
                if (choose(entry.value, false)) event.currentTarget.focus();
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                choose(entry.value, true);
              }}>
              {entry.icon}
              <span>{entry.label}</span>
            </button>)}
          </div>
          {reason ? <span id={reason} className={collection.detail}>{option.disabledReason}</span> : null}
        </div>
      </li>;
    }
    const attributes = {
      "data-action-id": option.id,
      "data-menu-row": option.id,
      "data-action-tone": option.tone ?? "default",
      "data-tone": option.tone ?? "default",
      "data-action-availability": option.disabled ? "Blocked" : "Available",
    } as const;
    if (option.kind === "custom") return <li role={sheet ? undefined : "none"} key={option.id}>
      <div role="group" aria-label={option.label} {...attributes}>
        {option.render({ closeMenu: () => close(true), closeMenuWithoutFocus: () => close(false),
          triggerEl: trigger.current, presentation: sheet ? "sheet" : "menu" })}
      </div>
    </li>;
    const control = projectActionControlState(option.label, option.kind === "command" ? option.state : undefined);
    const reason = option.disabled && option.disabledReason ? `${menuId}-reason-${index}` : undefined;
    const activate = (event: MouseEvent | KeyboardEvent) => {
      if (!("key" in event)) event.stopPropagation();
      const action = latestOption(option.id);
      if (!action || action.kind === "custom" || action.kind === "choice" || !checks.current.stable()) {
        event.preventDefault();
        invalidate();
        return;
      }
      if (action.disabled || action.busy) { if (!("key" in event) || ["Enter", " "].includes(event.key)) event.preventDefault(); return; }
      if (action.kind === "link") {
        const result = action.onActivate?.(event) ?? "unhandled";
        if (result === "consumed" || (result === "unhandled" && "key" in event)) return;
        close(result === "unhandled" && action.restoreFocusOnClose !== false);
        return;
      }
      const detail = prepareActionSelect(event, trigger.current);
      if (!detail) return;
      // Retire the menu owner before an async command captures attention.
      flushSync(() => close(action.restoreFocusOnClose !== false));
      action.onSelect(detail);
    };
    const common = {
      ...attributes,
      tabIndex: sheet ? 0 : -1,
      className: collection.row,
      "data-selected": control.menuChecked === true || undefined,
      "aria-label": sheet ? option.label : control.menuLabel,
      "aria-disabled": option.disabled || undefined,
      "aria-busy": option.busy || undefined,
      "aria-haspopup": option.hasPopup,
      "aria-describedby": reason,
      onKeyDown: activate, onClick: activate,
    };
    const body = <>
      <span className={`${collection.adornment} ${styles.menuItemIcon}`} aria-hidden="true">{option.icon}</span>
      <span className={`${collection.content} ${styles.menuText}`}>
        <span>{sheet ? option.label : control.menuLabel}</span>
        {reason ? <span id={reason} className={collection.detail}>{option.disabledReason}</span> : null}
      </span>
    </>;
    return <li role={sheet ? undefined : "none"} key={option.id}>
      {option.kind === "link" ? <a {...common} href={option.disabled ? undefined : option.href}
        role={sheet ? "link" : "menuitem"} data-workspace-rich-target={option.onActivate ? "true" : undefined}>{body}</a> :
        <button {...common} type="button" role={sheet ? undefined : control.menuRole}
          aria-checked={sheet ? undefined : control.menuChecked} aria-pressed={sheet ? control.barPressed : undefined}
          aria-expanded={control.barExpanded} aria-controls={control.barControls}>{body}</button>}
    </li>;
  };
  let itemIndex = 0;
  const trailingFirst = sheet || (lockedSide ?? menu.side) === "above";
  const body = content ? hasOptions ? <ul className={styles.sections} role={sheet ? undefined : "none"}>
    {content.sections.filter((section) => section.options.length > 0).map((section, sectionIndex) => <li key={section.id} role={sheet ? undefined : "none"}>
      {sectionIndex > 0 ? <div role="separator" className={styles.separator} /> : null}
      {section.label ? <div className={styles.sectionLabel}>{section.label}</div> : null}
      <ul className={styles.sections} role={sheet ? undefined : "group"} aria-label={section.label ?? undefined}>
        {section.options.map((option, index) => <Fragment key={option.id}>
          {option.separatorBefore && index > 0 ? <li role="separator" className={styles.separator} /> : null}
          {item(option, itemIndex++)}
        </Fragment>)}
      </ul>
    </li>)}
  </ul> : <p className={styles.menuStatus}>no actions available</p> : feedback ? <FeedbackNotice
    content={feedback} announcement="None"
    actions={[{ label: "retry", busy, onClick: () => { if (!busy) begin(current.current?.edge ?? "first", true); } }]}
  /> : null;
  const trailingView = trailingRegion && content && hasOptions ? <div role="none" data-menu-trailing="" className={styles.trailingRegion}>
    {trailingFirst ? null : <div role="separator" className={styles.separator} />}
    {trailing?.kind === "Ready" && trailing.options.length > 0
      ? <ul className={`${styles.sections} ${styles.trailing}`} role={sheet ? undefined : "group"} aria-label={trailing.label ?? undefined}>
        {trailing.options.map((option, index) => <Fragment key={option.id}>
          {option.separatorBefore && index > 0 ? <li role="separator" className={styles.separator} /> : null}
          {item(option, TRAILING_INDEX + index)}
        </Fragment>)}
      </ul>
      : trailing?.kind === "Failed" ? <ul className={`${styles.sections} ${styles.trailing}`} role={sheet ? undefined : "group"}>
        <li role={sheet ? undefined : "none"}><button type="button" role={sheet ? undefined : "menuitem"} aria-disabled="true"
          tabIndex={sheet ? 0 : -1} className={collection.row} data-action-availability="Blocked" onClick={event => event.preventDefault()}>
          <span className={`${collection.content} ${styles.menuText}`}>{trailing.feedback.title}</span></button></li>
      </ul>
      : <p className={`${styles.menuStatus} ${styles.trailing}`}>{trailing?.kind === "Ready" ? "no other actions" : "loading more actions…"}</p>}
    {trailingFirst ? <div role="separator" className={styles.separator} /> : null}
  </div> : null;
  const composed = trailingView ? <>
    {trailingFirst ? trailingView : null}
    <div role="none" data-menu-published="">{body}</div>
    {trailingFirst ? null : trailingView}
  </> : body;
  return <>
    {candidate && !sheet && container ? createPortal(<div ref={menu.ref} id={menuId} data-collection-viewport=""
      className={`${collection.surface} ${collection.contentViewport} ${styles.menu}`} role={hasOptions ? "menu" : "dialog"} aria-label={source.title}
      style={{ ...menu.style, visibility: visible ? menu.style.visibility : "hidden" }}
      tabIndex={-1} onKeyDownCapture={onSurfaceKeyDownCapture} onKeyDown={onSurfaceKeyDown}>{composed}</div>, container) : null}
    {sheet ? <MobileSheet active={sheet} ariaLabel={source.title} panelId={menuId} heightLimit="available" onDismiss={() => close(true)}
      interactionLayer={modalLayer} returnFocusTo={() => returnFocusTo?.() ?? trigger.current}
      skipReturnFocus={() => skipReturn.current} focusKey={focusKey}
      initialFocus={(panel) => {
        const active = current.current;
        if (active?.admission) {
          active.admission.phase = "Settling";
          checks.current.settleMobile();
          return panel;
        }
        if (current.current?.touch) return panel;
        if (!hasOptions) return content ? panel : focusableElements(panel).find((element) => sheetBody.current?.contains(element)) ?? panel;
        const items = [...(panel.querySelector<HTMLElement>("[data-menu-published]") ?? panel).querySelectorAll<HTMLElement>("[data-menu-row]")];
        const edge = items[current.current?.edge === "last" ? items.length - 1 : 0];
        // A choice edge focuses its checked radio, the group's one native tab stop.
        return edge?.matches("button, a") ? edge : edge?.querySelector<HTMLElement>('input[type="radio"]:checked:not(:disabled)')
          ?? edge?.querySelector<HTMLElement>("button, a, [tabindex]") ?? panel;
      }}>
      <div ref={sheetBody} data-collection-viewport="" className={`${collection.contentViewport} ${styles.sheetBody}`} style={{ visibility: visible ? undefined : "hidden" }} onKeyDownCapture={onSurfaceKeyDownCapture} onKeyDown={onSurfaceKeyDown}>{composed}</div>
    </MobileSheet> : null}
  </>;
}
