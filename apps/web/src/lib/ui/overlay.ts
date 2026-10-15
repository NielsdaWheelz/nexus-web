"use client";

// The overlay stack (docs/modules/overlays.md). Every open dialog, sheet, task,
// menu, chooser, floating surface and preview is a layer, in activation order.
// One owner answers Escape, Back and global commands: the newest eligible
// transient of the newest modal, else that modal; with no modal, the newest
// eligible page transient. A press outside transients closes them, newest
// first; a modal's scrim closes it only on a click that starts and ends there.
// While any modal is open exactly one synthetic history entry exists, so Back
// means "dismiss". Focus returns to whatever opened the layer being exposed.
//
// Escape and Tab are read by a document listener installed with the first
// layer, after React's root listeners: a component's own key handler runs
// first and keeps a key by preventing its default. A feature's global Escape
// command must yield while hasActiveInteractionOwner().

import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

export type DismissDecision = "accepted" | "blocked";
export type DismissReason = "escape" | "back" | "outside";
export type ReturnFocusTarget = () =>
  | HTMLElement
  | { readonly element: HTMLElement; readonly preventScroll: true }
  | null;

export interface OverlayOptions {
  readonly kind: "modal" | "transient";
  /** The one dismissal entry point; the feature closes by changing its state. */
  readonly onDismiss: (reason: DismissReason) => void;
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
}

export interface Layer {
  /** The modal this layer renders inside (React context), or null on the page. */
  readonly parent: Layer | null;
  readonly options: { readonly current: OverlayOptions };
  /** A modal's role="dialog" panel: the Tab trap root and its transients' container. */
  element: HTMLElement | null;
  /** The trigger, captured at open: where focus goes back to. */
  opener: ReturnType<ReturnFocusTarget>;
  /** The last dismissal dispatched to it. */
  reason: DismissReason | null;
}

const layers: Layer[] = [];
const listeners = new Set<() => void>();

const isModal = (layer: Layer) => layer.options.current.kind === "modal";
const topModal = () => layers.findLast(isModal) ?? null;
const topmost = (layer: Layer) =>
  topModal() === (isModal(layer) ? layer : layer.parent);
const depth = (layer: Layer) => layers.filter(isModal).indexOf(layer);

/** Who answers Escape and Back now, and whose scope names global commands. */
function owner(): Layer | undefined {
  const modal = topModal();
  const eligible = (layer: Layer) => layer.options.current.eligible?.() ?? true;
  return (
    layers.findLast(
      (layer) => layer.parent === modal && !isModal(layer) && eligible(layer),
    ) ?? (modal && eligible(modal) ? modal : undefined)
  );
}

function dispatch(layer: Layer, reason: DismissReason): void {
  layer.reason = reason;
  layer.options.current.onDismiss(reason);
}

export function hasActiveInteractionOwner(): boolean {
  return owner() !== undefined;
}

export function isTopmostInteractionOwner(scope: string): boolean {
  return owner()?.options.current.scope === scope;
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
if (typeof document !== "undefined") {
  const press = (event: Event) => {
    pressed = event.type === "keydown" ? null : (event.target as Element);
  };
  document.addEventListener("pointerdown", press, true);
  document.addEventListener("keydown", press, true);
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
  attempt();
  // An exposed modal stays inert until it re-renders.
  requestAnimationFrame(() => {
    if (unfocused()) attempt();
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
  if (!marked) return;
  marked = false;
  const layer = owner();
  if (layer) dispatch(layer, "back");
  // After React commits an accepted close: a modal that remains re-arms the entry.
  queueMicrotask(syncHistory);
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
    !items.includes(active) ||
    active === (event.shiftKey ? first : last)
  ) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

// Light dismiss: a press closes every transient of the top modal (or of the
// page) above the newest one it lands inside. A scrim press arms a modal's
// dismissal only when it closed nothing, so one press closes one layer.
let scrimPress: Layer | null = null;

function onPointerDown(event: PointerEvent): void {
  const modal = topModal();
  const target = event.target as Node;
  scrimPress = null;
  let closed = false;
  for (const layer of layers.toReversed()) {
    const { inside } = layer.options.current;
    if (layer.parent !== modal || isModal(layer) || !inside) continue;
    if (inside().some((element) => element?.contains(target))) return;
    dispatch(layer, "outside");
    closed = true;
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
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("click", onClick, true);
  window.addEventListener("popstate", onPopState);
}

// One history sync per commit: a modal that closes as another opens (a
// handoff) keeps the entry instead of traversing it off and pushing it back.
let syncScheduled = false;
function changed(): void {
  for (const listener of listeners) listener();
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

/** Where a transient renders: its containing modal's panel, else the body. */
export function useOverlayContainer(): HTMLElement | null {
  const parent = useContext(OverlayContext);
  if (typeof document === "undefined") return null;
  return parent ? parent.element : document.body;
}

/**
 * Keeps a layer on the stack while `open`. `topmost` is false while a newer
 * modal covers the layer (or its containing modal); `depth` is a modal's index
 * among open modals.
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
  }));

  useLayoutEffect(() => {
    if (!open) return;
    layer.opener = optionsRef.current.returnFocusTo?.() ?? trigger();
    layer.reason = null;
    install();
    layers.push(layer);
    changed();
    return () => {
      const current = optionsRef.current;
      const modal = current.kind === "modal";
      const exposed = topmost(layer);
      const wanted =
        modal || (current.returnFocus === true && layer.reason !== "outside");
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
  }, [open, layer]);

  // A host re-renders when its own layer is pushed or popped, covered or
  // exposed, or moves in depth: not on every change to the stack.
  useSyncExternalStore(
    subscribe,
    () => (layers.includes(layer) ? `${topmost(layer)}:${depth(layer)}` : ""),
    () => "",
  );
  return { layer, topmost: topmost(layer), depth: depth(layer) };
}
