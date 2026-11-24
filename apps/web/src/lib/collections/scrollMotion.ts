import { isEditableTarget, isNavigationAttention, NAVIGATION_ATTENTION_EVENTS } from "@/lib/ui/eventTarget";

export type ScrollMotion = "still" | "travel" | "seek";

type ScrollWrite = { readonly kind: "instant"; readonly offset: number } | { readonly kind: "smooth" };
const writes = new WeakMap<HTMLElement, ScrollWrite>();

/** A native scrollbar press targets the port itself, including overlay bars. */
export function isScrollportPress(event: PointerEvent, port: HTMLElement): boolean {
  return event.isTrusted && event.isPrimary && event.button === 0 && event.pointerType !== "touch" && event.target === port;
}

/** Scroll events are delivered later, so an assignment leaves its actual offset behind. */
export function writeScrollPosition(port: HTMLElement, top: number, behavior?: ScrollBehavior): void {
  const before = port.scrollTop;
  if (behavior === "smooth") {
    if (Math.abs(Math.max(0, Math.min(top, port.scrollHeight - port.clientHeight)) - before) <= 0.5) return;
    writes.set(port, { kind: "smooth" });
    port.scrollTo({ top, behavior });
  } else {
    port.scrollTop = top;
    if (port.scrollTop !== before) writes.set(port, { kind: "instant", offset: port.scrollTop });
  }
}

type ScrollClaim = "wheel" | "key" | "touch" | "incidental";

const SCROLL_KEYS = new Set(["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "]);

/** The gesture owns presentation until it settles. This observer never moves the port. */
export function observeScrollMotion(port: HTMLElement, onMotion: (motion: ScrollMotion) => void,
  onForward?: (port: HTMLElement) => void, onAttention?: () => void): () => void {
  const hasScrollEnd = "onscrollend" in port;
  let motion: ScrollMotion = "still";
  let wheelTravel = false;
  let lastTop = port.scrollTop;
  let lastMaximum = Math.max(0, port.scrollHeight - port.clientHeight);
  let press: number | null = null;
  let claim: { cancel(): void; kind: ScrollClaim } | null = null;
  let quiet: ReturnType<typeof setTimeout> | null = null;
  let settle: number | null = null;
  const change = (next: ScrollMotion) => {
    if (motion === next) return;
    motion = next;
    if (next !== "travel") wheelTravel = false;
    onMotion(next);
  };
  const clearClaim = () => {
    claim?.cancel();
    claim = null;
  };
  const clearQuiet = () => {
    if (quiet !== null) clearTimeout(quiet);
    quiet = null;
  };
  const clearSettle = () => {
    if (settle !== null) cancelAnimationFrame(settle);
    settle = null;
  };
  const settleSoon = () => {
    clearSettle();
    settle = requestAnimationFrame(() => {
      settle = null;
      if (press !== null) return;
      if (claim === null) change("still");
      else settleSoon();
    });
  };
  const arm = (kind: ScrollClaim) => {
    if (press !== null || kind === "incidental" && claim !== null && claim.kind !== "incidental") return;
    clearClaim();
    const expire = () => {claim = null;};
    if (kind !== "incidental") writes.delete(port);
    if (kind === "wheel" || kind === "touch") {
      let frame = requestAnimationFrame(() => {frame = requestAnimationFrame(expire);});
      claim = {kind, cancel: () => cancelAnimationFrame(frame)};
    } else {
      // Gecko can begin a key’s default smooth scroll after two paint frames.
      const timer = setTimeout(expire, 150);
      claim = {kind, cancel: () => clearTimeout(timer)};
    }
  };
  const wheel = (event: WheelEvent) => {
    if (event.isTrusted && !event.defaultPrevented && !event.ctrlKey && event.deltaY !== 0) arm("wheel");
  };
  const key = (event: KeyboardEvent) => {
    if (!event.isTrusted) return;
    arm(!event.defaultPrevented && !event.altKey && !event.ctrlKey && !event.metaKey &&
      SCROLL_KEYS.has(event.key) && !isEditableTarget(event.target) ? "key" : "incidental");
  };
  const incidental = (event: Event) => {
    if (event.isTrusted) arm("incidental");
  };
  const touch = (event: TouchEvent) => {
    if (event.isTrusted && !event.defaultPrevented && event.touches.length === 1) arm("touch");
  };
  const down = (event: PointerEvent) => {
    if (!isScrollportPress(event, port)) {
      incidental(event);
      return;
    }
    clearClaim();
    clearSettle();
    clearQuiet();
    writes.delete(port);
    press = event.pointerId;
    change("seek");
  };
  const release = () => {
    if (press === null) return;
    press = null;
    clearClaim();
    settleSoon();
  };
  const up = (event: PointerEvent) => {
    if (event.isTrusted && event.pointerId === press) release();
  };
  const lost = (event: PointerEvent) => {
    if (event.isTrusted && event.pointerId === press && (event.buttons & 1) === 0) release();
  };
  const visibility = () => { if (document.hidden) release(); };
  const scroll = (event: Event) => {
    if (event.target !== port) return;
    const top = port.scrollTop;
    const maximum = Math.max(0, port.scrollHeight - port.clientHeight);
    const clamped = top < lastTop && Math.abs(top - maximum) <= 0.5 && maximum < lastMaximum;
    lastMaximum = maximum;
    const forward = top > lastTop;
    const moved = top !== lastTop;
    lastTop = top;
    const write = writes.get(port);
    if (write?.kind === "smooth") return;
    writes.delete(port);
    if (!moved || clamped && press === null || write?.kind === "instant" && Math.abs(top - write.offset) <= 0.5) return;
    const gesture = claim !== null && claim.kind !== "incidental";
    const demand = gesture || motion === "travel";
    const incidentalMovement = press === null && claim?.kind === "incidental" && !demand;
    if (gesture) wheelTravel = claim?.kind === "wheel";
    clearClaim();
    if (incidentalMovement) {
      if (motion === "seek") settleSoon();
      return;
    }
    if (demand) clearSettle();
    else if (settle !== null) settleSoon();
    change(press === null && demand ? "travel" : "seek");
    clearQuiet();
    // Firefox can deliver wheel travel without a completion event. Only wheel
    // travel infers completion on a port with native scrollend support.
    if (press === null && (wheelTravel || !hasScrollEnd)) {
      quiet = setTimeout(() => {
        quiet = null;
        settleSoon();
      }, 180);
    }
    if (forward && (demand || press !== null)) onForward?.(port);
  };
  const end = (event: Event) => {
    if (event.target !== port) return;
    clearQuiet();
    writes.delete(port);
    if (press === null) settleSoon();
  };
  const attention = (event: Event) => {
    if (isNavigationAttention(event)) onAttention?.();
  };

  if (onAttention) for (const type of NAVIGATION_ATTENTION_EVENTS) port.addEventListener(type, attention, true);
  port.addEventListener("scroll", scroll, { passive: true });
  port.addEventListener("scrollend", end);
  port.addEventListener("wheel", wheel, { passive: true });
  port.addEventListener("keydown", key);
  const incidentalEvents = ["beforeinput", "compositionstart", "focusin"];
  for (const type of incidentalEvents) port.addEventListener(type, incidental);
  port.addEventListener("touchmove", touch, { passive: true });
  port.addEventListener("pointerdown", down);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
  window.addEventListener("pointermove", lost, true);
  window.addEventListener("pointerover", lost, true);
  window.addEventListener("blur", release);
  window.addEventListener("pagehide", release);
  document.addEventListener("visibilitychange", visibility);
  return () => {
    if (onAttention) for (const type of NAVIGATION_ATTENTION_EVENTS) port.removeEventListener(type, attention, true);
    port.removeEventListener("scroll", scroll);
    port.removeEventListener("scrollend", end);
    port.removeEventListener("wheel", wheel);
    port.removeEventListener("keydown", key);
    for (const type of incidentalEvents) port.removeEventListener(type, incidental);
    port.removeEventListener("touchmove", touch);
    port.removeEventListener("pointerdown", down);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", up, true);
    window.removeEventListener("pointermove", lost, true);
    window.removeEventListener("pointerover", lost, true);
    window.removeEventListener("blur", release);
    window.removeEventListener("pagehide", release);
    document.removeEventListener("visibilitychange", visibility);
    clearClaim();
    clearSettle();
    clearQuiet();
    writes.delete(port);
  };
}
