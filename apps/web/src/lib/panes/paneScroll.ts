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
