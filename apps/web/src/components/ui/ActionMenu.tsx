"use client";

import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { isStaleBuild } from "@/lib/api/client";
import { useNavigationIdentity } from "@/lib/host/policy";
import { useMobileChromeHold } from "@/lib/mobileShell/chrome";
import {
  activateDescriptor,
  projectActionControlState,
  type MenuContent,
  type MenuOption,
  type MenuSource,
} from "@/lib/ui/actionDescriptor";
import { cx } from "@/lib/ui/cx";
import { isEditableTarget } from "@/lib/ui/eventTarget";
import {
  focusableElements,
  getInteractionOwner,
  handleModalTab,
  restoreFocus,
  useInteractionOwner,
  useOverlay,
  useOverlayContainer,
  type Layer,
  type ReturnFocusTarget,
} from "@/lib/ui/overlay";
import { useAnchoredPosition } from "@/lib/ui/useAnchoredPosition";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useIndexRowWindow } from "@/lib/collections/indexRowWindow";
import { ActionMenuHost, viewportGeometry, type ActionMenuHostProps, type ActionMenuSession } from "./ActionMenuHost";
import { ControlContents } from "./control";
import MobileSheet from "./MobileSheet";
import RadioGroup from "./RadioGroup";
import styles from "./ActionMenu.module.css";
import choiceField from "./ChoiceField.module.css";
import selection from "./Selection.module.css";
import collection from "./Collection.module.css";

const PREPARATION_BUDGET_MS = 5000;
const TRAILING_INDEX = 10_000;
// Moving focus into a sheet can dismiss the IME. Admit after its geometry quiets;
// there is no portable keyboard-transition completion event.
const MOBILE_ADMISSION_QUIET_MS = 150;
const ITEMS = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

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
  readonly edge: "first" | "last" | null;
  readonly touch: boolean;
  readonly attempt: Attempt | null;
  readonly visible: boolean;
  /** The delayed region could not prepare: `more actions` ends the menu. */
  readonly failed: boolean;
  readonly meaning: string | null;
  readonly geometry: readonly number[] | null;
  readonly preparedMeaning: string | null;
  readonly preparedGeometry: readonly number[] | null;
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
        option.disabledReason, option.waiting, option.separatorBefore,
        state?.kind === "toggle" ? [state.kind, state.pressed] : state ?
          [state.kind, state.expanded, state.controls, state.menuLabels.collapsed, state.menuLabels.expanded] : null,
      ];
    }),
  ])]);
}

/** The trailing region may change after publication; only published rows define geometry. */
function geometry(anchor: HTMLElement, body: HTMLElement, mobile: boolean, selector: string | null): readonly number[] {
  const panel = mobile ? body.closest<HTMLElement>("[data-modal-panel]") : body;
  if (!panel) throw new Error("a mobile action menu requires its visual sheet panel");
  const box = panel.getBoundingClientRect();
  let panelX = box.x;
  let panelY = box.y;
  if (mobile) {
    // The available MobileSheet bottom-aligns in its fixed, untransformed
    // backdrop without bottom spacing. Its fractional height avoids offsetTop
    // rounding without mixing the sheet's compositor translation samples.
    const parent = panel.offsetParent;
    if (!parent) throw new Error("mobile action sheet requires its layout containing block");
    const origin = parent.getBoundingClientRect();
    panelX = origin.left + parent.clientLeft + panel.offsetLeft - parent.scrollLeft;
    panelY = origin.bottom - box.height - parent.scrollTop;
  }
  const position = anchor.getBoundingClientRect();
  const rows = [...body.querySelectorAll<HTMLElement>(selector ?? "[data-menu-row]")].map((row) => {
    const rect = row.getBoundingClientRect();
    let x = rect.left - box.left;
    let y = rect.top - box.top;
    for (let parent = row.parentElement; parent; parent = parent.parentElement) {
      x += parent.scrollLeft;
      y += parent.scrollTop;
      if (parent === panel) break;
    }
    return selector !== null ? [panelX + x, panelY + y, rect.width, rect.height] : [x, y, rect.width, rect.height];
  });
  return selector !== null ? [position.x, position.y, position.width, position.height, ...rows.flat()] : [
    position.x, position.y, position.width, position.height,
    panelX, panelY, box.width, box.height,
    ...rows.flat(),
  ];
}

function trailingRoom(scroller: HTMLElement, mobile: boolean): number {
  const published = scroller.querySelector<HTMLElement>("[data-menu-published]");
  if (!published) throw new Error("a trailing menu requires its published content block");
  const style = getComputedStyle(scroller);
  const used = published.getBoundingClientRect().height
    + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  if (!mobile) return parseFloat(style.maxBlockSize) - used;
  const panel = scroller.closest<HTMLElement>("[data-modal-panel]");
  const parent = panel?.parentElement;
  if (!panel || !parent) throw new Error("a mobile trailing menu requires its sheet containing block");
  const containing = getComputedStyle(parent);
  const available = parent.getBoundingClientRect().height
    - parseFloat(containing.paddingTop) - parseFloat(containing.paddingBottom)
    - parseFloat(containing.borderTopWidth) - parseFloat(containing.borderBottomWidth);
  return available - (panel.getBoundingClientRect().height - scroller.getBoundingClientRect().height) - used;
}

/** Rows that arrive after publication. A withdrawn one returns only its own lost focus to the menu. */
function DelayedMenuRegion({ children, returnFocus }: {
  readonly children: ReactNode;
  readonly returnFocus: () => HTMLElement | null;
}) {
  const root = useRef<HTMLDivElement>(null);
  useActionFocusRecovery(root, returnFocus);
  return <div ref={root} role="none" data-menu-trailing="" className={styles.lateRegion}>{children}</div>;
}

/**
 * One invocation owns initial publication, preparation and dismissal. Known initial
 * controls publish without completing the preparation deadline. The first ready
 * prepared snapshot freezes separately. A menu holds verbs alone: a menu with no initial
 * controls never opens on a failure, which its host says; a delayed region that fails
 * ends the menu with `more actions`, which re-prepares in a new invocation. Published
 * meaning and geometry stay fixed while callbacks and availability remain current.
 * The host (`./ActionMenuHost`) owns the trigger and its sessions.
 */
export interface ActionMenuProps extends Omit<ActionMenuHostProps, "title" | "subjectKey" | "children"> {
  readonly source: MenuSource;
  /** Reports actual visibility only; it never starts preparation. */
  readonly onOpenChange?: (open: boolean) => void;
  readonly placement?: "below" | "above";
  readonly align?: "start" | "center" | "end";
  readonly returnFocusTo?: ReturnFocusTarget;
}
export { ActionMenuHost, type ActionMenuContextAnchorProps, type ActionMenuSession } from "./ActionMenuHost";

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
  const { trigger, root, menuId } = session;
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
  const hasInitial = source.kind === "Prepared" && source.initial.sections.some(section => section.options.length > 0);
  const trailingRegion = source.kind === "Prepared" && (hasInitial || source.trailing !== undefined);
  const trailing = trailingRegion && invocation?.attempt && !invocation.attempt.controller.signal.aborted &&
    source.trailing?.request === invocation.attempt.controller.signal ? source.trailing ?? null : null;
  const content = invocation && (source.kind === "Immediate" ? source.content : hasInitial ? source.initial :
    prepared?.kind === "Ready" ? prepared.content : null);
  const delayedContent = hasInitial && prepared?.kind === "Ready" ? prepared.content : null;
  const hasOptions = content?.sections.some((section) => section.options.length > 0) ?? false;
  const requested = invocation !== null;
  const candidate = invocation !== null && hasOptions;
  const sheet = candidate && invocation?.mobile === true;
  const visible = invocation?.visible === true && invocation.admission === null;
  // The trigger spins while anything this invocation asked for is on its way.
  const busy = invocation?.attempt?.timer != null || trailing?.kind === "Loading";
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
    // The preparation layer yields to its own sheet without ending the invocation.
    returnFocus: !sheet,
    returnFocusTo: () => returnFocusTo?.() ?? trigger.current,
    skipReturnFocus: () => skipReturn.current,
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
  /** `error` is null when the budget ran out. With no initial controls nothing opens, and the
   * host reports it; otherwise the published rows stay and `more actions` ends them. A stale
   * build offers reload alone: `more actions` would only fail again, so the host reports it
   * instead, and a menu not yet shown does not open. */
  const fail = (attempt: Attempt, error: unknown) => {
    const active = current.current;
    if (!active || active.attempt !== attempt) return;
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.timer = null;
    const stale = isStaleBuild(error);
    if (!hasInitial || stale && !active.visible) {
      close(false);
      session.failed(error);
      return;
    }
    if (stale) session.failed(error);
    change({ ...active, attempt: null, failed: !stale, preparedMeaning: null, preparedGeometry: null });
    attempt.controller.abort();
  };
  const begin = (edge: "first" | "last" | null) => {
    const previous = current.current;
    if (previous?.admission?.timer) clearTimeout(previous.admission.timer);
    const attempt: Attempt | null = source.kind === "Prepared" ? {
      controller: new AbortController(), expires: session.startedAt + PREPARATION_BUDGET_MS, timer: null,
    } : null;
    skipReturn.current = false;
    change({
      subject: session.subjectKey, title: session.title, mobile: session.mobile, pathname: session.pathname, edge,
      viewport: session.viewport, touch: session.touch, attempt, visible: false, failed: false,
      meaning: null, geometry: null, preparedMeaning: null, preparedGeometry: null, side: null,
      admission: mobile ? { phase: "Focus", timer: null } : null,
    });
    if (attempt && source.kind === "Prepared") {
      attempt.timer = setTimeout(() => fail(attempt, null), Math.max(0, attempt.expires - performance.now()));
      source.prepare(attempt.controller.signal);
    }
  };
  useLayoutEffect(() => {
    begin(session.edge);
    // An invocation owns its activation deadline; strict replay reacquires it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);
  useLayoutEffect(() => {
    session.present({ visible, busy });
  });
  // The close returns focus to the trigger, which names itself; a platform menu dismisses silently too.
  const invalidate = () => {
    if (current.current) close(true);
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
    const ready = value.kind === "Immediate" ? value.content : hasInitial ? value.initial :
      value.state?.kind === "Ready" && value.state.request === active.attempt?.controller.signal
        ? value.state.content : null;
    if (ready === null || active.meaning !== meaning(value.title, ready) ||
      node === null || active.geometry === null) return false;
    const measured = geometry(trigger.current, node, active.mobile, trailingRegion ? "[data-menu-published] [data-menu-row]" : null);
    // Compositor/transform serialization noise can cross rounding boundaries.
    // Compare at 1/64 CSS px precision against the fixed publication snapshot.
    if (active.geometry.length !== measured.length || !active.geometry.every(
      (coordinate, index) => Math.abs(coordinate - measured[index]) <= 1 / 64,
    )) return false;
    if (active.preparedMeaning === null) return true;
    if (value.kind !== "Prepared" || value.state?.kind !== "Ready" ||
      value.state.request !== active.attempt?.controller.signal ||
      active.preparedMeaning !== meaning(value.title, value.state.content) || active.preparedGeometry === null) return false;
    const delayed = geometry(trigger.current, node, active.mobile, "[data-menu-prepared] [data-menu-row]");
    return active.preparedGeometry.length === delayed.length && active.preparedGeometry.every(
      (coordinate, index) => Math.abs(coordinate - delayed[index]) <= 1 / 64,
    );
  };
  // Measure each publication before paint. Only prepared readiness completes the
  // attempt; its snapshot must still beat the preparation deadline.
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
    // A failure and an unpublished empty answer need no surface, so neither waits for a sheet's admission.
    if (prepared?.kind === "Failed" && active.attempt) {
      fail(active.attempt, prepared.error);
      return;
    }
    if (active.meaning === null && content !== null && !hasOptions) {
      close(false);
      session.empty();
      return;
    }
    if (active.admission !== null && active.admission.phase !== "Ready") return;
    if (active.meaning !== null) {
      if (!stable()) { invalidate(); return; }
      if (delayedContent && active.preparedMeaning === null && active.attempt) {
        if (performance.now() >= active.attempt.expires) { fail(active.attempt, null); return; }
        if (active.attempt.timer) clearTimeout(active.attempt.timer);
        active.attempt.timer = null;
        const node = surface();
        if (!node) return;
        change({ ...active, preparedMeaning: meaning(source.title, delayedContent),
          preparedGeometry: geometry(trigger.current, node, active.mobile, "[data-menu-prepared] [data-menu-row]"),
        });
      }
      return;
    }
    if (prepared?.kind === "Ready" && active.attempt && performance.now() >= active.attempt.expires) {
      fail(active.attempt, null);
      return;
    }
    if (content === null || !candidate || (!sheet && !menu.placed)) return;
    const node = surface();
    if (!node || !trigger.current) return;
    if (trailingRegion && !active.mobile && active.side === null) {
      const placed = node.getBoundingClientRect().bottom <= trigger.current.getBoundingClientRect().top + 1 ? "above" : "below";
      change({ ...active, side: placed });
      return;
    }
    if (prepared?.kind === "Ready" && active.attempt?.timer) {
      clearTimeout(active.attempt.timer);
      active.attempt.timer = null;
    }
    if (trailingRegion) {
      const region = node.querySelector<HTMLElement>("[data-menu-trailing]");
      const room = region ? trailingRoom(node, active.mobile) : NaN;
      if (region && Number.isFinite(room)) region.style.maxBlockSize = `${Math.max(region.getBoundingClientRect().height, room)}px`;
    }
    change({
      ...active, visible: true, viewport: viewportGeometry(), admission: null,
      meaning: meaning(source.title, content),
      geometry: geometry(trigger.current, node, active.mobile, trailingRegion ? "[data-menu-published] [data-menu-row]" : null),
      preparedMeaning: delayedContent ? meaning(source.title, delayedContent) : null,
      preparedGeometry: delayedContent ? geometry(trigger.current, node, active.mobile, "[data-menu-prepared] [data-menu-row]") : null,
    });
    session.opened();
  };
  const checks = useRef({ stable, invalidate, close, surface, publish, settleMobile });
  checks.current = { stable, invalidate, close, surface, publish, settleMobile };
  // Source and invocation are read after every commit; callback identity is not
  // a lifecycle boundary or permission to publish.
  // Layout finishers settle in microtasks before this geometry is certified.
  useLayoutEffect(() => {
    if (!requested) return;
    const frame = requestAnimationFrame(() => checks.current.publish());
    return () => cancelAnimationFrame(frame);
  });

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
  const focusKey = invocation?.admission ?? invocation?.meaning;
  // The first publication owns focus; delayed readiness and retry retain its key.
  // Content stays hidden until its measured publication commits.
  useLayoutEffect(() => {
    if (!visible || sheet || !current.current) return;
    const node = menu.ref.current;
    if (!node) return;
    const items = [...node.querySelectorAll<HTMLElement>(ITEMS)];
    const controls = items.length ? items : focusableElements(node);
    const location = current.current.edge === null ? node.querySelector<HTMLElement>('[aria-current="location"]') : null;
    (location ?? controls[current.current.edge === "last" ? controls.length - 1 : 0] ?? node).focus();
  }, [visible, sheet, focusKey, menu.ref]);

  // A touch invocation keeps panel focus; reveal its current place only once.
  const revealed = useRef(false);
  useLayoutEffect(() => {
    if (revealed.current || !visible || !sheet || !current.current?.touch || current.current.edge !== null) return;
    revealed.current = true;
    sheetBody.current?.querySelector<HTMLElement>('[aria-current="location"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [visible, sheet]);

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
    return [...(value.kind === "Prepared" ? value.initial.sections.flatMap(section => section.options) : []), ...(ready?.sections.flatMap((section) => section.options) ?? []), ...later].find((entry) => entry.id === id);
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
              className={cx(choiceField.segment, selection.surface, selection.target, entry.value === option.value && selection.selected)} aria-disabled={option.disabled || undefined} aria-describedby={reason}
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
      const result = activateDescriptor(action, event, trigger.current, close);
      if (result === "selected" || result === "consumed" || (result === "unhandled" && "key" in event)) return;
      close(result === "unhandled" && action.restoreFocusOnClose !== false);
    };
    const common = {
      ...attributes,
      tabIndex: sheet ? 0 : -1,
      className: collection.row,
      "aria-current": option.current,
      "data-selected": control.menuChecked === true || undefined,
      "aria-label": sheet ? option.label : control.menuLabel,
      "aria-disabled": option.disabled || undefined,
      "aria-busy": option.busy || undefined,
      "aria-haspopup": option.hasPopup,
      "aria-describedby": reason,
      onKeyDown: activate, onClick: activate,
    };
    const body = <>
      <span className={`${collection.adornment} ${styles.menuItemIcon}`} aria-hidden="true">
        <ControlContents icon={option.icon ?? undefined} busy={option.busy === true} />
        {option.current === "location" ? <span className={styles.currentMarker} /> : null}
      </span>
      <span className={`${collection.content} ${styles.menuText}`}>
        <span>{sheet ? option.label : control.menuLabel}</span>
        {reason ? <span id={reason} className={option.waiting ? "sr-only" : collection.detail}>{option.disabledReason}</span> : null}
      </span>
    </>;
    return <li role={sheet ? undefined : "none"} key={option.id}>
      {option.kind === "link" ? <a {...common} href={option.disabled ? undefined : option.href} target={option.target} rel={option.target === "_blank" ? "noopener noreferrer" : undefined}
        role={sheet ? "link" : "menuitem"} data-workspace-rich-target={option.onActivate ? "true" : undefined}>{body}</a> :
        <button {...common} type="button" role={sheet ? undefined : control.menuRole}
          aria-checked={sheet ? undefined : control.menuChecked} aria-pressed={sheet ? control.barPressed : undefined}
          aria-expanded={control.barExpanded} aria-controls={control.barControls}>{body}</button>}
    </li>;
  };
  let itemIndex = 0;
  // Late rows land on the side away from the trigger, so nothing moves under the hand.
  const trailingFirst = sheet || (lockedSide ?? menu.side) === "above";
  const separator = <div role="separator" className={styles.separator} />;
  const contentView = (value: MenuContent) => value.sections.some(section => section.options.length > 0) ? <ul className={styles.sections} role={sheet ? undefined : "none"}>
    {value.sections.filter((section) => section.options.length > 0).map((section, sectionIndex) => <li key={section.id} role={sheet ? undefined : "none"}>
      {sectionIndex > 0 ? separator : null}
      {section.label ? <div className={styles.sectionLabel}>{section.label}</div> : null}
      <ul className={styles.sections} role={sheet ? undefined : "group"} aria-label={section.label ?? undefined}>
        {section.options.map((option, index) => <Fragment key={option.id}>
          {option.separatorBefore && index > 0 ? <li role="separator" className={styles.separator} /> : null}
          {item(option, itemIndex++)}
        </Fragment>)}
      </ul>
    </li>)}
  </ul> : null;
  // A delayed region that failed ends the menu with an ordinary verb: it closes, prepares
  // everything again in a new invocation, and reopens. Under a stale build that verb would only
  // fail again, so the host offers reload instead, once the menu stands.
  const reprepare = () => {
    flushSync(() => close(true));
    session.reopen();
  };
  const staleTrailing = trailing?.kind === "Failed" && isStaleBuild(trailing.error) ? trailing.error : null;
  useLayoutEffect(() => {
    if (visible && staleTrailing !== null) session.failed(staleTrailing);
  }, [visible, staleTrailing, session]);
  const more = invocation?.failed === true || trailing?.kind === "Failed" && staleTrailing === null ? <ul className={`${styles.sections} ${styles.late}`} role={sheet ? undefined : "none"}>
    <li role={sheet ? undefined : "none"}>
      <button type="button" role={sheet ? undefined : "menuitem"} tabIndex={sheet ? 0 : -1} className={collection.row} data-menu-row="more-actions" onClick={reprepare}>
        <span className={`${collection.adornment} ${styles.menuItemIcon}`} aria-hidden="true" />
        <span className={`${collection.content} ${styles.menuText}`}><span>more actions</span></span>
      </button>
    </li>
  </ul> : null;
  const trailingRows = trailing?.kind === "Ready" && trailing.options.length > 0
    ? <ul className={`${styles.sections} ${styles.late}`} role={sheet ? undefined : "group"} aria-label={trailing.label ?? undefined}>
      {trailing.label ? <li role={sheet ? undefined : "none"} className={styles.sectionLabel}>{trailing.label}</li> : null}
      {trailing.options.map((option, index) => <Fragment key={option.id}>
        {option.separatorBefore && index > 0 ? <li role="separator" className={styles.separator} /> : null}
        {item(option, TRAILING_INDEX + index)}
      </Fragment>)}
    </ul> : null;
  /** Late groups, nearest the published rows first. Each stands behind a separator on its
   * near side, and they read away from the trigger. */
  const late = (groups: readonly ReactNode[]) => {
    const placed = groups.filter(group => group !== null).map((group, index) => trailingFirst
      ? <Fragment key={index}>{group}{separator}</Fragment> : <Fragment key={index}>{separator}{group}</Fragment>);
    return trailingFirst ? placed.reverse() : placed;
  };
  const preparedRows = delayedContent ? <div role="none" data-menu-prepared="" className={styles.late}>{contentView(delayedContent)}</div> : null;
  // With initial controls, trailing facts follow the prepared rows they belong to.
  const lateView = trailingRegion ? <DelayedMenuRegion returnFocus={() => current.current?.visible
    ? current.current.mobile ? modalLayer.current?.element ?? null : menu.ref.current : null}>
    {late([preparedRows, !hasInitial || delayedContent !== null ? trailingRows : null, more])}
  </DelayedMenuRegion> : null;
  const body = content ? contentView(content) : null;
  const composed = lateView ? <>
    {trailingFirst ? lateView : null}
    <div role="none" data-menu-published="">{body}</div>
    {trailingFirst ? null : lateView}
  </> : body;
  return <>
    {candidate && !sheet && container ? createPortal(<div ref={menu.ref} id={menuId} data-collection-viewport=""
      className={`${collection.surface} ${collection.contentViewport} ${styles.menu}`} role="menu" aria-label={source.title}
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
        const items = [...(panel.querySelector<HTMLElement>("[data-menu-published]") ?? panel).querySelectorAll<HTMLElement>("[data-menu-row]")];
        const location = current.current?.edge === null ? panel.querySelector<HTMLElement>('[aria-current="location"]') : null;
        const edge = location ?? items[current.current?.edge === "last" ? items.length - 1 : 0];
        // A choice edge focuses its checked radio, the group's one native tab stop.
        return edge?.matches("button, a") ? edge : edge?.querySelector<HTMLElement>('input[type="radio"]:checked:not(:disabled)')
          ?? edge?.querySelector<HTMLElement>("button, a, [tabindex]") ?? panel;
      }}>
      <div ref={sheetBody} data-collection-viewport="" className={`${collection.contentViewport} ${styles.sheetBody}`} style={{ visibility: visible ? undefined : "hidden" }} onKeyDownCapture={onSurfaceKeyDownCapture} onKeyDown={onSurfaceKeyDown}>{composed}</div>
    </MobileSheet> : null}
  </>;
}
