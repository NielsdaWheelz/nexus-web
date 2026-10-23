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
} from "react";
import { createPortal, flushSync } from "react-dom";
import { useNavigationIdentity } from "@/lib/host/policy";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import { useMobileChromeHold } from "@/lib/mobileShell/chrome";
import {
  prepareActionSelect,
  projectActionControlState,
  type ActionDescriptor,
  type MenuContent,
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
import MobileSheet from "./MobileSheet";
import OverflowMenuButton from "./OverflowMenuButton";
import styles from "./ActionMenu.module.css";
import collection from "./Collection.module.css";

const PREPARATION_BUDGET_MS = 5000;
const ITEMS = '[role="menuitem"], [role="menuitemcheckbox"]';
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
};

/** Displayed meaning excludes closures and availability; execution reads current descriptors. */
function meaning(title: string, content: MenuContent): string {
  return JSON.stringify([title, content.sections.map((section) => [
    section.id, section.label, section.options.map((option) => {
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

/** Scroll is intentional; sheet entry/drag transforms do not change content coordinates. */
function geometry(anchor: HTMLElement, body: HTMLElement, mobile: boolean): readonly number[] {
  const panel = mobile ? body.closest<HTMLElement>('[role="dialog"]') ?? body : body;
  const box = panel.getBoundingClientRect();
  const transform = getComputedStyle(panel).transform;
  const movement = transform === "none" ? null : new DOMMatrixReadOnly(transform);
  const position = anchor.getBoundingClientRect();
  const rows = [...body.querySelectorAll<HTMLElement>("[data-menu-row]")].map((row) => {
    const rect = row.getBoundingClientRect();
    let x = rect.left - box.left;
    let y = rect.top - box.top;
    for (let parent = row.parentElement; parent; parent = parent.parentElement) {
      x += parent.scrollLeft;
      y += parent.scrollTop;
      if (parent === panel) break;
    }
    return [x, y, rect.width, rect.height];
  });
  return [
    position.x, position.y, position.width, position.height,
    box.x - (movement?.m41 ?? 0), box.y - (movement?.m42 ?? 0), box.width, box.height,
    ...rows.flat(),
  ];
}

/**
 * One invocation owns preparation, publication and dismissal. Initial preparation
 * has one hidden transient; publication has one desktop transient or mobile frame.
 * A complete measured result must beat its activation-time deadline. Published
 * meaning and geometry are immutable; callbacks and availability remain current.
 */
export default function ActionMenu({
  source,
  label = `more actions for ${source.title}`,
  className,
  onOpenChange,
  placement = "below",
  align = "end",
  renderTrigger,
  renderContextAnchor,
  triggerAttributes,
  triggerRef,
  triggerDisabled = false,
  triggerDisabledReason,
  returnFocusTo,
}: {
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
}) {
  const [invocation, setInvocation] = useState<Invocation | null>(null);
  const current = useRef(invocation);
  const latest = useRef(source);
  latest.current = source;
  const [announcement, announce] = useState("");
  const trigger = useRef<HTMLElement | null>(null);
  const setTrigger = useCallback((node: HTMLButtonElement | null) => {
    trigger.current = node;
    triggerRef?.(node);
  }, [triggerRef]);
  const root = useRef<HTMLDivElement>(null);
  const sheetBody = useRef<HTMLDivElement>(null);
  const modalLayer = useRef<Layer | null>(null);
  const skipReturn = useRef(false);
  const releasePress = useRef<(() => void) | null>(null);
  const triggerId = useId();
  const menuId = useId();
  const reasonId = useId();
  const container = useOverlayContainer();
  const mobile = useIsMobileViewport();
  const pathname = useNavigationIdentity();
  useInteractionOwner();
  const prepared = source.kind === "Prepared" && invocation?.attempt &&
    !invocation.attempt.controller.signal.aborted &&
    source.state?.request === invocation.attempt.controller.signal ? source.state : null;
  const content = invocation && (source.kind === "Immediate" ? source.content :
    prepared?.kind === "Ready" ? prepared.content : null);
  const feedback = invocation?.feedback ?? null;
  const hasChoices = content?.sections.some((section) => section.options.length > 0) ?? false;
  const requested = invocation !== null;
  const candidate = invocation !== null && (content !== null || feedback !== null);
  const sheet = candidate && invocation?.mobile === true;
  const visible = invocation?.visible ?? false;
  const busy = invocation?.attempt?.timer != null;
  useMobileChromeHold(invocation !== null);
  const menu = useAnchoredPosition<HTMLDivElement>(trigger, {
    enabled: candidate && !sheet && container !== null,
    placement, align, flip: true, keepAnchorVisible: true,
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
  };
  const close = (returnFocus = true) => {
    const active = current.current;
    if (!active) return;
    if (active.attempt?.timer) clearTimeout(active.attempt.timer);
    skipReturn.current = true;
    if (returnFocus) restoreFocus(active.mobile && modalLayer.current ? modalLayer.current : layer);
    change(null);
    active.attempt?.controller.abort();
  };
  closeRef.current = close;
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
    const now = performance.now();
    const attempt: Attempt | null = source.kind === "Prepared" ? {
      controller: new AbortController(), expires: now + PREPARATION_BUDGET_MS, timer: null,
    } : null;
    skipReturn.current = false;
    change({
      subject: source.subjectKey, title: source.title, mobile, pathname, edge,
      viewport: viewportGeometry(),
      touch: retry ? false : wasOverlayInvokedByTouch(),
      attempt, visible: retry, feedback: retry ? previous?.feedback ?? null : null,
      meaning: null, geometry: null,
    });
    if (attempt && source.kind === "Prepared") {
      attempt.timer = setTimeout(() => fail(attempt, FAILED), Math.max(0, attempt.expires - performance.now()));
      announce("loading actions…");
      source.prepare(attempt.controller.signal);
    } else announce("");
  };
  const invalidate = () => {
    if (!current.current) return;
    close(true);
    announce("actions changed. reopen to see current options.");
  };
  const stable = () => {
    const active = current.current;
    const node = surface();
    if (!active || !trigger.current?.isConnected || !trigger.current.getClientRects().length) return false;
    if (active.subject !== latest.current.subjectKey || active.title !== latest.current.title ||
      active.viewport !== viewportGeometry()) return false;
    if (active.meaning === null) return true;
    const value = latest.current;
    const ready = value.kind === "Immediate" ? value.content :
      value.state?.kind === "Ready" && value.state.request === active.attempt?.controller.signal
        ? value.state.content : null;
    if (ready === null || active.meaning !== meaning(value.title, ready) ||
      node === null || active.geometry === null) return false;
    const measured = geometry(trigger.current, node, active.mobile);
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
    if (!active) return;
    if (active.subject !== source.subjectKey || active.mobile !== mobile || active.pathname !== pathname) {
      closeRef.current(false);
      return;
    }
    if (active.viewport !== viewportGeometry()) {
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
    if (content && active.attempt?.timer) {
      clearTimeout(active.attempt.timer);
      active.attempt.timer = null;
    }
    if (content || !active.visible) {
      change({
        ...active, visible: true, feedback: content ? null : active.feedback,
        meaning: content ? meaning(source.title, content) : null,
        geometry: content ? geometry(trigger.current, node, active.mobile) : null,
      });
      if (content && !hasChoices) announce("no actions available");
      else if (content) announce("");
    }
  };
  const checks = useRef({ stable, invalidate, close, surface, publish });
  checks.current = { stable, invalidate, close, surface, publish };
  // Source and invocation are read after every commit; callback identity is not
  // a lifecycle boundary or permission to publish.
  useLayoutEffect(() => { checks.current.publish(); });

  // Capture checks precede custom handlers and native/shifted/auxiliary defaults.
  useLayoutEffect(() => {
    if (!requested) return;
    const press = (event: PointerEvent) => {
      releasePress.current?.();
      if (!current.current?.visible || checks.current.stable()) return;
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
      const node = checks.current.surface();
      if (event.target instanceof Node && !root.current?.contains(event.target) && !node?.contains(event.target)
        && !modalLayer.current?.element?.contains(event.target)) checks.current.close(false);
    };
    const resize = () => {
      if (current.current?.visible) checks.current.invalidate(); else checks.current.close(false);
    };
    const retire = () => checks.current.close(false);
    const scroll = (event: Event) => {
      const node = checks.current.surface();
      if (event.target instanceof Node && node?.contains(event.target)) return;
      if (current.current?.mobile && event.target instanceof Node && modalLayer.current?.element?.contains(event.target)) return;
      if (!checks.current.stable()) checks.current.invalidate();
    };
    const observer = new ResizeObserver(() => {
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
  }, [requested, visible, sheet]);
  useLayoutEffect(() => () => {
    releasePress.current?.();
    const active = current.current;
    if (active?.attempt?.timer) clearTimeout(active.attempt.timer);
    active?.attempt?.controller.abort();
  }, []);
  const report = useRef(onOpenChange);
  report.current = onOpenChange;
  useEffect(() => {
    if (!visible) return;
    report.current?.(true);
    return () => report.current?.(false);
  }, [visible]);
  const focusKey = invocation?.meaning ?? invocation?.feedback;
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
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(ITEMS)];
    if (!items.length) return;
    const active = document.activeElement;
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

  const item = (option: ActionDescriptor, index: number) => {
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
      const latestContent = latest.current.kind === "Immediate" ? latest.current.content :
        latest.current.state?.kind === "Ready" ? latest.current.state.content : null;
      const action = latestContent?.sections.flatMap((section) => section.options).find((entry) => entry.id === option.id);
      if (!action || action.kind === "custom" || !checks.current.stable()) {
        event.preventDefault();
        invalidate();
        return;
      }
      if (action.disabled) { if (!("key" in event) || ["Enter", " "].includes(event.key)) event.preventDefault(); return; }
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
  const body = content ? hasChoices ? <ul className={styles.sections} role={sheet ? undefined : "none"}>
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
  const hold = useRef<{ pointer: number; x: number; y: number; timer: ReturnType<typeof setTimeout>; owner: Layer | null; generation: number; subject: string } | null>(null);
  const heldClick = useRef(false);
  const touchGesture = useRef(false);
  const cancelHold = () => {
    if (hold.current) clearTimeout(hold.current.timer);
    hold.current = null;
  };
  const consumeHeldClick = (pointer: number) => {
    releasePress.current?.();
    heldClick.current = true;
    const release = () => {
      window.removeEventListener("click", consume, true);
      window.removeEventListener("pointerdown", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("keydown", release, true);
      releasePress.current = null;
      heldClick.current = false;
    };
    const consume = (event: globalThis.MouseEvent) => {
      if (event instanceof globalThis.PointerEvent && event.pointerId > 0 && event.pointerId !== pointer) return;
      release(); event.preventDefault(); event.stopImmediatePropagation();
    };
    releasePress.current = release;
    window.addEventListener("click", consume, true);
    window.addEventListener("pointerdown", release, true);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("keydown", release, true);
  };
  useEffect(() => {
    window.addEventListener("scroll", cancelHold, true);
    window.addEventListener("blur", cancelHold);
    return () => {
      cancelHold();
      window.removeEventListener("scroll", cancelHold, true);
      window.removeEventListener("blur", cancelHold);
    };
  }, []);
  useEffect(() => { cancelHold(); heldClick.current = false; }, [source.subjectKey, pathname]);
  const popup = mobile || (candidate && !hasChoices) ? "dialog" : "menu";
  const triggerProps: ActionMenuTriggerProps = {
    ...triggerAttributes,
    ref: setTrigger,
    type: "button", id: triggerId, "aria-label": label,
    "aria-describedby": triggerDisabled && triggerDisabledReason ? reasonId : undefined,
    "aria-disabled": triggerDisabled || undefined,
    "aria-haspopup": popup, "aria-controls": visible ? menuId : undefined,
    "aria-expanded": visible, "aria-busy": busy,
    onClick: (event) => {
      event.stopPropagation();
      if (triggerDisabled) return;
      if (current.current) close(false); else begin("first");
    },
    onKeyDown: (event) => {
      if (triggerDisabled || event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Tab" && current.current) { close(false); return; }
      if (event.key === "Enter" || event.key === " ") {
        // Native click opens on Enter's press or Space's release, before focus moves.
        if (event.repeat) event.preventDefault();
        event.stopPropagation();
        return;
      }
      const edge = event.key === "ArrowUp" ? "last" : event.key === "ArrowDown" ? "first" : null;
      if (!edge) return;
      event.preventDefault(); event.stopPropagation();
      if (current.current) close(false); else begin(edge);
    },
  };
  return <div ref={root} className={[styles.container, className].filter(Boolean).join(" ")} data-open={visible ? "true" : "false"}>
    {renderContextAnchor ? renderContextAnchor({
      ref: (node) => { trigger.current = node; },
      id: triggerId, "aria-haspopup": popup, "aria-controls": visible ? menuId : undefined,
      "aria-expanded": visible, "aria-busy": busy,
      onContextMenu: (event) => {
        event.preventDefault(); event.stopPropagation();
        const pending = hold.current;
        if (touchGesture.current || (event.nativeEvent instanceof globalThis.PointerEvent && event.nativeEvent.pointerType === "touch")) {
          if (!pending || pending.owner !== getInteractionOwner() || pending.generation !== getInteractionGeneration() || pending.subject !== latest.current.subjectKey) { cancelHold(); return; }
          consumeHeldClick(pending.pointer);
        }
        cancelHold();
        if (!triggerDisabled && !current.current) begin("first");
      },
      onKeyDown: (event) => {
        touchGesture.current = false;
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.repeat) return;
        if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
        event.preventDefault(); event.stopPropagation(); cancelHold();
        if (!triggerDisabled && !current.current) begin("first");
      },
      onPointerDown: (event) => {
        cancelHold(); heldClick.current = false;
        touchGesture.current = event.pointerType === "touch";
        if (triggerDisabled || event.pointerType !== "touch" || !event.isPrimary) return;
        const { pointerId: pointer, clientX: x, clientY: y } = event;
        const owner = getInteractionOwner();
        const generation = getInteractionGeneration();
        hold.current = { pointer, x, y, owner, generation, subject: source.subjectKey, timer: setTimeout(() => {
          if (!hold.current || hold.current.owner !== getInteractionOwner() || hold.current.generation !== getInteractionGeneration() || hold.current.subject !== latest.current.subjectKey || !trigger.current?.isConnected) { cancelHold(); return; }
          consumeHeldClick(pointer); cancelHold();
          if (!current.current) begin("first");
        }, 500) };
      },
      onPointerMove: (event) => {
        const pending = hold.current;
        if (pending && (event.pointerId !== pending.pointer || Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 8)) cancelHold();
      },
      onPointerUp: () => cancelHold(), onPointerCancel: cancelHold,
      onClickCapture: (event) => {
        if (!heldClick.current) return;
        heldClick.current = false; event.preventDefault(); event.stopPropagation();
      },
    }) : renderTrigger ? renderTrigger(triggerProps) : <OverflowMenuButton {...triggerProps} />}
    {triggerDisabled && triggerDisabledReason ? <span id={reasonId} className="sr-only">{triggerDisabledReason}</span> : null}
    <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</span>
    {candidate && !sheet && container ? createPortal(<div ref={menu.ref} id={menuId} data-collection-viewport=""
      className={`${collection.surface} ${collection.compactViewport} ${styles.menu}`} role={hasChoices ? "menu" : "dialog"} aria-label={source.title}
      style={{ ...menu.style, visibility: visible ? menu.style.visibility : "hidden" }}
      tabIndex={-1} onKeyDownCapture={onSurfaceKeyDownCapture} onKeyDown={onSurfaceKeyDown}>{body}</div>, container) : null}
    <MobileSheet active={sheet} ariaLabel={source.title} panelId={menuId} onDismiss={() => close(true)}
      interactionLayer={modalLayer} returnFocusTo={() => returnFocusTo?.() ?? trigger.current}
      skipReturnFocus={() => skipReturn.current} focusKey={focusKey}
      initialFocus={(panel) => {
        if (current.current?.touch) return panel;
        if (!hasChoices) return content ? panel : focusableElements(panel).find((element) => sheetBody.current?.contains(element)) ?? panel;
        const items = [...panel.querySelectorAll<HTMLElement>("[data-menu-row]")];
        const edge = items[current.current?.edge === "last" ? items.length - 1 : 0];
        return edge?.matches("button, a") ? edge : edge?.querySelector<HTMLElement>("button, a, [tabindex]") ?? panel;
      }}>
      <div ref={sheetBody} data-collection-viewport="" className={`${collection.compactViewport} ${styles.sheetBody}`} style={{ visibility: visible ? undefined : "hidden" }} onKeyDownCapture={onSurfaceKeyDownCapture} onKeyDown={onSurfaceKeyDown}>{body}</div>
    </MobileSheet>
  </div>;
}
