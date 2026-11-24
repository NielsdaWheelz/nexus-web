import { isEditableTarget } from "@/lib/ui/eventTarget";

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

const SCROLL_KEYS = new Set(["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "]);

/** The gesture owns presentation until it settles. This observer never moves the port. */
export function observeScrollMotion(port: HTMLElement, onMotion: (motion: ScrollMotion) => void,
  onForward?: (port: HTMLElement) => void): () => void {
  let motion: ScrollMotion = "still";
  let lastTop = port.scrollTop;
  let press: number | null = null;
  let claim: number | null = null;
  let settle: number | null = null;
  const change = (next: ScrollMotion) => {
    if (motion === next) return;
    motion = next;
    onMotion(next);
  };
  const clearClaim = () => {
    if (claim !== null) cancelAnimationFrame(claim);
    claim = null;
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
  const arm = () => {
    clearClaim();
    writes.delete(port);
    claim = requestAnimationFrame(() => {
      claim = requestAnimationFrame(() => {
        claim = null;
        if (motion === "seek" && press === null) settleSoon();
      });
    });
  };
  const wheel = (event: WheelEvent) => {
    if (event.isTrusted && !event.defaultPrevented && !event.ctrlKey && event.deltaY !== 0) arm();
  };
  const key = (event: KeyboardEvent) => {
    if (event.isTrusted && !event.defaultPrevented && !event.altKey && !event.ctrlKey && !event.metaKey &&
      SCROLL_KEYS.has(event.key) && !isEditableTarget(event.target)) arm();
  };
  const touch = (event: TouchEvent) => {
    if (event.isTrusted && !event.defaultPrevented && event.touches.length === 1) arm();
  };
  const down = (event: PointerEvent) => {
    if (!isScrollportPress(event, port)) return;
    clearClaim();
    clearSettle();
    writes.delete(port);
    press = event.pointerId;
    change("seek");
  };
  const release = () => {
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
    const forward = top > lastTop;
    const moved = top !== lastTop;
    lastTop = top;
    if (!moved) return;
    const write = writes.get(port);
    if (write?.kind === "smooth") return;
    writes.delete(port);
    if (write?.kind === "instant" && Math.abs(top - write.offset) <= 0.5) return;
    const newlyClaimed = claim !== null;
    const claimed = newlyClaimed || motion === "travel";
    clearClaim();
    if (newlyClaimed) clearSettle();
    else if (settle !== null) settleSoon();
    change(press === null && claimed ? "travel" : "seek");
    if (forward && (claimed || press !== null)) onForward?.(port);
  };
  const end = (event: Event) => {
    if (event.target !== port) return;
    writes.delete(port);
    if (press === null) settleSoon();
  };

  port.addEventListener("scroll", scroll, { passive: true });
  port.addEventListener("scrollend", end);
  port.addEventListener("wheel", wheel, { passive: true });
  port.addEventListener("keydown", key);
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
    port.removeEventListener("scroll", scroll);
    port.removeEventListener("scrollend", end);
    port.removeEventListener("wheel", wheel);
    port.removeEventListener("keydown", key);
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
    writes.delete(port);
  };
}
