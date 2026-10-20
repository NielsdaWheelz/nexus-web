"use client";

// The overlay stack (docs/modules/overlays.md). Every open dialog, sheet, task,
// menu, chooser, floating surface and preview is a layer, in activation order;
// tooltips register while pending or visible. One interactive owner answers
// Escape, Back and global commands: the newest eligible transient of the newest
// modal, else that modal; with no modal, the newest
// eligible page transient. A press outside transients closes them, newest
// first; a modal's scrim closes it only on a click that starts and ends there.
// While any modal is open exactly one synthetic history entry exists, so Back
// means "dismiss". Focus returns to whatever opened the layer being exposed.
// Opted-in transients retire on real browser navigation; a frame's synthetic
// closing traversal never dismisses a newer invocation.
//
// Escape and Tab are read by a document listener installed with the first
// layer, after React's root listeners: a component's own key handler runs
// first and keeps a key by preventing its default. A feature's global Escape
// command must yield while hasActiveInteractionOwner(). Tooltip Escape runs in
// capture: it cancels pending hints and dismisses the newest visible hint of
// the exposed surface before the focused control can handle that key.

import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

export type DismissDecision = "accepted" | "blocked";
export type DismissReason = "escape" | "back" | "outside" | "tab" | "navigation";
export type ReturnFocusTarget = () =>
  | HTMLElement
  | { readonly element: HTMLElement; readonly preventScroll: true }
  | null;

export type OverlayOptions = {
  /** The one dismissal entry point; the feature closes by changing its state. */
  readonly onDismiss: (reason: DismissReason) => void;
} & (
  | ((
      | { readonly kind: "modal"; readonly dismissOnNavigation?: never }
      | {
          readonly kind: "transient";
          /** Retire on actual browser traversal, excluding the frame's own cleanup. */
          readonly dismissOnNavigation?: boolean;
        }
    ) & {
      /** A transient's own boxes: a press there is not outside. Absent: no press closes it. */
      readonly inside?: () => readonly (Element | null)[];
      /** Read at dispatch: false passes Escape and Back to the next layer. */
      readonly eligible?: () => boolean;
      /** Names the layer for isTopmostInteractionOwner. */
      readonly scope?: string;
      /** A modal always returns focus when it closes; a transient only when set. */
      readonly returnFocus?: boolean;
      readonly returnFocusTo?: ReturnFocusTarget;
      readonly returnFocusFallback?: ReturnFocusTarget;
      /** Read at close: true when the close already put focus elsewhere. */
      readonly skipReturnFocus?: () => boolean;
      /** Opt-in transient Tab exit. Its controls precede the next control after its opener. */
      readonly tabContinuation?: () => HTMLElement | null;
    })
  | {
      readonly kind: "tooltip";
      readonly dismissOnNavigation?: never;
      readonly trigger: () => HTMLElement | null;
      readonly inside: () => readonly (Element | null)[];
      /** Registered while pending or visible; true only while visible. */
      readonly eligible: () => boolean;
      readonly scope?: never;
      readonly returnFocus?: never;
      readonly returnFocusTo?: never;
      readonly returnFocusFallback?: never;
      readonly skipReturnFocus?: never;
      readonly tabContinuation?: never;
    }
);

export interface Layer {
  /** The modal this layer renders inside (React context), or null on the page. */
  parent: Layer | null;
  readonly options: { readonly current: OverlayOptions };
  /** A modal's role="dialog" panel: the Tab trap root and its transients' container. */
  element: HTMLElement | null;
  /** The interactive layer's trigger, captured at open; tooltips keep null. */
  opener: ReturnType<ReturnFocusTarget>;
  /** The last dismissal dispatched to it. */
  reason: DismissReason | null;
  /** Last observed eligibility; a new admission relinquishes pending navigation. */
  interactive: boolean;
}

const layers: Layer[] = [];
const listeners = new Set<() => void>();
let interactionGeneration = 0;

const isModal = (layer: Layer) => layer.options.current.kind === "modal";
const topModal = () => layers.findLast(isModal) ?? null;
function topmost(layer: Layer): boolean {
  if (topModal() !== (isModal(layer) ? layer : layer.parent)) return false;
  const options = layer.options.current;
  if (options.kind !== "tooltip") return true;
  const trigger = options.trigger();
  if (!trigger?.isConnected || trigger.closest("[hidden], [inert]")) return false;
  const interaction = owner();
  if (!interaction) return true;
  if (isModal(interaction)) return interaction.element?.contains(trigger) ?? false;
  return interaction.options.current.inside?.().some((element) => element?.contains(trigger)) ?? false;
}
const depth = (layer: Layer) => layers.filter(isModal).indexOf(layer);

/** Who answers Escape and Back now, and whose scope names global commands. */
function owner(excludingTransient?: Layer): Layer | undefined {
  const modal = topModal();
  const eligible = (layer: Layer) => layer.options.current.eligible?.() ?? true;
  return (
    layers.findLast(
      (layer) =>
        layer !== excludingTransient &&
        layer.parent === modal &&
        layer.options.current.kind === "transient" &&
        eligible(layer),
    ) ?? (modal && eligible(modal) ? modal : undefined)
  );
}

function dispatch(layer: Layer, reason: DismissReason): void {
  layer.reason = reason;
  layer.options.current.onDismiss(reason);
}

export function hasActiveModal(): boolean {
  return topModal() !== null;
}

/** Observe the existing stack; feedback never owns modal state. */
export function useModalActive(): boolean {
  return useSyncExternalStore(subscribe, hasActiveModal, () => false);
}

export function hasActiveInteractionOwner(): boolean {
  return owner() !== undefined;
}

/** A delayed result may retain its initiating layer, but never a competing one. */
export function getInteractionOwner(): Layer | null {
  return owner() ?? null;
}

/** The exact owner exposed when the initiating transient closes normally. */
export function getInteractionOwnerBelow(layer: Layer): Layer | null {
  return owner(layer) ?? null;
}

/** Pending destination focus resumes when the existing overlay owner leaves. */
export function useInteractionOwner(): Layer | null {
  return useSyncExternalStore(subscribe, getInteractionOwner, () => null);
}

export function isTopmostInteractionOwner(scope: string): boolean {
  return owner()?.options.current.scope === scope;
}

/** New interactive admissions or user Back, excluding an overlay's own closing traversal. */
export function getInteractionGeneration(): number {
  return interactionGeneration;
}

export function useInteractionBlocked(scope: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => {
      const current = owner();
      return current !== undefined && current.options.current.scope !== scope;
    },
    () => false,
  );
}

// Candidates only: tabIndex (-1 for a disabled link or a non-editable region) decides.
const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, iframe, [contenteditable], [tabindex]";

export function focusableElements(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.tabIndex >= 0 && !element.closest("[hidden], [inert]"),
  );
}

// Safari never focuses a clicked button: a layer that opens with nothing
// focused names as its trigger the focusable element the last press landed on
// (a key press clears it: a key-opened layer's trigger is the focused element).
let pressed: Element | null = null;
let touchInvocation = false;
if (typeof document !== "undefined") {
  const press = (event: Event) => {
    pressed = event.type === "keydown" ? null : (event.target as Element);
    touchInvocation = event.type === "pointerdown"
      && (event as PointerEvent).pointerType !== "mouse";
  };
  document.addEventListener("pointerdown", press, true);
  document.addEventListener("keydown", press, true);
}

/** Initial-focus policy reads the same input origin that identifies the opener. */
export function wasOverlayInvokedByTouch(): boolean {
  return touchInvocation;
}

function trigger(): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) return active;
  return pressed?.closest<HTMLElement>(FOCUSABLE) ?? null;
}

// Focus is lost on the body, or in a frame that just closed (hidden) or was
// covered (inert): the browser moves it to the body only after the next layout.
const unfocused = () => {
  const active = document.activeElement;
  return (
    active === null ||
    active === document.body ||
    active.closest("[hidden], [inert]") !== null
  );
};

function focus(target: ReturnType<ReturnFocusTarget>): boolean {
  const element = target instanceof HTMLElement ? target : target?.element;
  if (!element?.isConnected) return false;
  const attempt = () => {
    if (element.isConnected && !element.closest("[inert]")) {
      element.focus({ preventScroll: !(target instanceof HTMLElement) });
    }
  };
  let superseded = false;
  const claimedFocus = (event: FocusEvent) => {
    if (event.target !== element) superseded = true;
  };
  document.addEventListener("focusin", claimedFocus, true);
  attempt();
  // An exposed modal stays inert until it re-renders. A new focus owner cancels
  // this return, even if that owner's later detachment leaves focus on the body.
  requestAnimationFrame(() => {
    document.removeEventListener("focusin", claimedFocus, true);
    if (!superseded && unfocused()) attempt();
  });
  return true;
}

/** Returns focus for `layer` now, the way its close will. */
export function restoreFocus(layer: Layer): void {
  const { returnFocusTo, returnFocusFallback } = layer.options.current;
  if (!focus(returnFocusTo?.() ?? null) && !focus(layer.opener)) {
    focus(returnFocusFallback?.() ?? null);
  }
}

const MARKER = "__nexusOverlay";
let marked = false; // our entry is the current one
let popping: string | null = null; // the address to keep while traversing it off
let settlements: Array<() => void> = [];
const here = () => location.pathname + location.search + location.hash;

// One entry while any modal is open. After the last closes, traverse it off;
// if the address moved meanwhile (a navigating close), the landed entry keeps it.
function syncHistory(): void {
  if (popping !== null) return;
  if (topModal()) {
    if (!marked) history.pushState({ ...history.state, [MARKER]: true }, "");
    marked = true;
    settlements = [];
  } else if (marked) {
    marked = false;
    popping = here();
    history.back();
  } else if (settlements.length > 0) {
    const pending = settlements;
    settlements = [];
    // A traversal can drop focus to the body: restore what the last close did.
    requestAnimationFrame(() => {
      if (unfocused()) for (const run of pending) run();
    });
  }
}

function onPopState(): void {
  if (popping !== null) {
    const address = popping;
    popping = null;
    if (here() !== address) {
      // After the router has seen the traversal.
      requestAnimationFrame(() => history.replaceState(null, "", address));
    }
    syncHistory();
    return;
  }
  interactionGeneration += 1;
  const layer = owner();
  if (!marked) {
    const options = layer?.options.current;
    if (layer && options?.kind === "transient" && options.dismissOnNavigation)
      dispatch(layer, "navigation");
    return;
  }
  marked = false;
  if (layer) dispatch(layer, "back");
  // After React commits an accepted close: a modal that remains re-arms the entry.
  queueMicrotask(syncHistory);
}

function onTooltipEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing)
    return;
  const modal = topModal();
  let visible: Layer | null = null;
  for (const layer of layers.toReversed()) {
    const options = layer.options.current;
    if (options.kind !== "tooltip") continue;
    if (!options.eligible()) dispatch(layer, "escape");
    else if (visible === null && layer.parent === modal && topmost(layer)) visible = layer;
  }
  if (visible === null) return;
  event.preventDefault();
  event.stopPropagation();
  dispatch(visible, "escape");
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing) return;
  if (event.key === "Escape") {
    const layer = owner();
    if (!layer) return;
    event.preventDefault();
    dispatch(layer, "escape");
    return;
  }
  if (event.key !== "Tab") return;
  const modal = topModal();
  const layer = owner();
  const boundary = layer?.options.current.tabContinuation?.();
  const active = document.activeElement as HTMLElement;
  if (layer && boundary?.contains(active)) {
    const controls = focusableElements(boundary);
    if (controls.length === 0 || active === (event.shiftKey ? controls[0] : controls.at(-1))) {
      const anchor = [
        layer.options.current.returnFocusTo?.(), layer.opener,
        layer.options.current.returnFocusFallback?.(), modal?.element,
      ].map((target) => target instanceof HTMLElement ? target : target?.element)
        .find((element) => element?.isConnected && element.getClientRects().length > 0
          && !element.closest("[hidden], [inert]") && !element.matches(":disabled"));
      const outside = focusableElements(modal?.element ?? document.body)
        .filter((element) => !boundary.contains(element));
      const index = anchor ? outside.indexOf(anchor) : -1;
      const next = event.shiftKey ? anchor
        : index >= 0 ? outside[index + 1] ?? (modal ? outside[0] : null) : anchor;
      dispatch(layer, "tab");
      if (next?.isConnected) {
        event.preventDefault();
        focus(next);
      }
      return;
    }
  }
  handleModalTab(event);
}

/** The modal boundary also applies when a transient isolates its key events. */
export function handleModalTab(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">,
): void {
  const panel = topModal()?.element;
  if (event.key !== "Tab" || !panel) return;
  // The Tab trap: focus wraps inside the top modal's panel.
  const items = focusableElements(panel);
  const first = items[0];
  const last = items.at(-1);
  const active = document.activeElement as HTMLElement;
  if (!first || !last) {
    event.preventDefault();
    panel.focus();
  } else if (
    !panel.contains(active) ||
    active === (event.shiftKey ? first : last) ||
    // A programmatic trigger may have tabindex=-1. Let native Tab continue
    // from its position unless no tabbable remains in that direction.
    (!items.includes(active) &&
      !items.some((item) =>
        active.compareDocumentPosition(item) &
        (event.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING),
      ))
  ) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus({ preventScroll: true });
  }
}

// Light dismiss: a press closes every transient of the top modal (or of the
// page) above the newest one it lands inside. A scrim press arms a modal's
// dismissal only when it closed nothing, so one press closes one layer.
let scrimPress: Layer | null = null;

function onPointerDown(event: PointerEvent): void {
  const modal = topModal();
  let target = event.target as Node;
  scrimPress = null;
  let closed = false;
  for (const layer of layers.toReversed()) {
    const options = layer.options.current;
    const { kind, inside } = options;
    if (layer.parent !== modal || kind === "modal" || !inside) continue;
    if (inside().some((element) => element?.contains(target))) {
      if (kind === "transient") return;
      // A caption's portal belongs to the same surface as its trigger.
      const trigger = options.kind === "tooltip" ? options.trigger() : null;
      if (trigger && topmost(layer)) target = trigger;
    } else {
      dispatch(layer, "outside");
      if (kind === "transient") closed = true;
    }
  }
  if (!closed && modal && target === modal.element?.parentElement) {
    scrimPress = modal;
  }
}

// The click lands on the scrim only when the press both started and ended
// there: a text drag released over it keeps the modal.
function onClick(event: MouseEvent): void {
  const modal = scrimPress;
  scrimPress = null;
  if (
    modal &&
    modal === topModal() &&
    event.target === modal.element?.parentElement
  ) {
    dispatch(modal, "outside");
  }
}

let installed = false;
function install(): void {
  if (installed) return;
  installed = true;
  document.addEventListener("keydown", onTooltipEscape, true);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("focusin", notifyInteraction);
  // Observe the settled focus, not the temporary body focus between two
  // descendants of the same owner. Blurring to the page still publishes.
  document.addEventListener("focusout", () => queueMicrotask(notifyInteraction));
  window.addEventListener("popstate", onPopState);
}

function notifyInteraction(): void {
  for (const layer of layers) {
    const options = layer.options.current;
    const interactive = options.kind !== "tooltip" && (options.eligible?.() ?? true);
    if (interactive && !layer.interactive) interactionGeneration += 1;
    layer.interactive = interactive;
  }
  for (const listener of listeners) listener();
}

// One history sync per commit: a modal that closes as another opens (a
// handoff) keeps the entry instead of traversing it off and pushing it back.
let syncScheduled = false;
function changed(): void {
  notifyInteraction();
  if (syncScheduled) return;
  syncScheduled = true;
  queueMicrotask(() => {
    syncScheduled = false;
    syncHistory();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Provided by ModalFrame: the modal its children render inside. */
export const OverlayContext = createContext<Layer | null>(null);

/** Where a transient or tooltip renders: its containing modal's panel, else the body. */
export function useOverlayContainer(): HTMLElement | null {
  const parent = useContext(OverlayContext);
  if (typeof document === "undefined") return null;
  return parent ? parent.element : document.body;
}

/**
 * Keeps a layer on the stack while `open`. `topmost` is false while a newer
 * modal covers the layer (or its containing modal); `depth` is a modal's index
 * among open modals. A tooltip is exposed only inside the current interaction
 * owner (or on the page with no owner), and registers while pending or visible.
 */
export function useOverlay(
  open: boolean,
  options: OverlayOptions,
): {
  readonly layer: Layer;
  readonly topmost: boolean;
  readonly depth: number;
} {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const parent = useContext(OverlayContext);
  const [layer] = useState<Layer>(() => ({
    parent,
    options: optionsRef,
    element: null,
    opener: null,
    reason: null,
    interactive: false,
  }));

  useLayoutEffect(() => {
    // A retained subtree may move between the page and a modal. Rebind only
    // after the previous admission's cleanup has used its original parent.
    layer.parent = parent;
    if (!open) return;
    const opening = optionsRef.current;
    layer.opener =
      opening.kind === "tooltip" ? null : (opening.returnFocusTo?.() ?? trigger());
    layer.reason = null;
    layer.interactive = false;
    install();
    layers.push(layer);
    changed();
    return () => {
      const current = optionsRef.current;
      const modal = current.kind === "modal";
      const exposed = topmost(layer);
      const wanted =
        modal || (current.returnFocus === true && layer.reason !== "outside" && layer.reason !== "tab" && layer.reason !== "navigation");
      layers.splice(layers.indexOf(layer), 1);
      if (exposed && wanted && !current.skipReturnFocus?.()) {
        restoreFocus(layer);
        // The last modal's close traverses history; restore once it lands.
        if (modal && topModal() === null) {
          settlements.push(() => restoreFocus(layer));
        }
      }
      changed();
    };
  }, [open, layer, parent]);

  useLayoutEffect(() => {
    if (open) notifyInteraction();
  });

  // A host re-renders when its own layer is pushed or popped, covered or
  // exposed, or moves in depth: not on every change to the stack.
  useSyncExternalStore(
    subscribe,
    () => (layers.includes(layer) ? `${topmost(layer)}:${depth(layer)}` : ""),
    () => "",
  );
  return { layer, topmost: topmost(layer), depth: depth(layer) };
}
