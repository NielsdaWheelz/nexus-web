/** A pane's chrome draws its foot hairline once the pane's body has scrolled. Whichever element
 * scrolls the body reports here; the shell's `data-scrolled` is the whole contract, read by css. */

/** The port that wrote each shell's attribute last: a released port clears only its own word. */
const writers = new WeakMap<HTMLElement, HTMLElement>();

export function publishPaneScroll(port: HTMLElement): () => void {
  const shell = port.closest<HTMLElement>("[data-pane-shell]");
  if (shell === null) throw new Error("a pane scroll port requires its pane shell");
  const write = () => {
    writers.set(shell, port);
    shell.toggleAttribute("data-scrolled", port.scrollTop > 0);
  };
  write();
  port.addEventListener("scroll", write, { passive: true });
  return () => {
    port.removeEventListener("scroll", write);
    if (writers.get(shell) === port) { writers.delete(shell); shell.removeAttribute("data-scrolled"); }
  };
}

/** A state page owns its port directly through a React callback ref. */
export function paneScrollRef(port: HTMLElement | null) {
  if (port !== null) return publishPaneScroll(port);
}

/** The part of a scroll port a reader can see, in viewport coordinates. The port's top padding is the
 * phone's opaque chrome (the mobile viewport contract), so what stands under it is not seen. */
export function paneVisibleBand(port: HTMLElement): { top: number; bottom: number } {
  const bounds = port.getBoundingClientRect();
  return { top: bounds.top + parseFloat(getComputedStyle(port).paddingTop), bottom: bounds.bottom };
}

/** Runs `measure` at most once a frame after the port scrolls, or it or any of `resized` changes size.
 * The first measurement is the caller's, at the moment its own contract names. `schedule` asks for
 * one more; `release` stops everything, a pending frame included. */
export function watchPaneGeometry(port: HTMLElement, resized: readonly Element[], measure: () => void): { schedule(): void; release(): void } {
  let frame: number | null = null;
  const schedule = () => {
    if (frame === null) frame = requestAnimationFrame(() => { frame = null; measure(); });
  };
  port.addEventListener("scroll", schedule, { passive: true });
  const sizes = new ResizeObserver(schedule);
  sizes.observe(port);
  for (const element of resized) sizes.observe(element);
  return {
    schedule,
    release: () => {
      port.removeEventListener("scroll", schedule);
      sizes.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    },
  };
}
