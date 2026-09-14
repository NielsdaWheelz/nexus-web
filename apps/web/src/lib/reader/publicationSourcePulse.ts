import "./apparatus.css";
import type { ReaderSourceRangeLease, ReaderViewCapacity } from "./DocumentReaderSession";
import type { ReaderPublicationSourceRange } from "./publicationContract";
import { visitPublicationTextRangeRects, type PublicationGutterTextPart } from "./publicationGutter";

/** The exact visible portion pulses; its full verified provenance remains in the location lease. */
export function pulsePublicationSource({ parts, range, viewport, lease, signal }: {
  readonly parts: Iterable<PublicationGutterTextPart>;
  readonly range: ReaderPublicationSourceRange;
  readonly viewport: DOMRect;
  readonly lease: ReaderSourceRangeLease;
  readonly signal: AbortSignal;
}): { readonly finished: Promise<boolean>; release(): void } | ReaderViewCapacity {
  signal.throwIfAborted();
  const nodes: HTMLElement[] = [];
  let finish!: (positioned: boolean) => void;
  const finished = new Promise<boolean>((resolve) => { finish = resolve; });
  let retired = false;
  const retire = (positioned: boolean) => {
    if (retired) return;
    retired = true;
    signal.removeEventListener("abort", cancel);
    for (const node of nodes) {
      node.removeEventListener("animationend", completed);
      node.removeEventListener("animationcancel", cancel);
      node.remove();
    }
    nodes.length = 0;
    finish(positioned);
  };
  const cancel = () => retire(false);
  const completed = (event: AnimationEvent) => {
    if (event.animationName === "reader-source-pulse") retire(true);
  };
  let refused: ReaderViewCapacity | null = null;
  try {
  for (const part of parts) {
    const origin = part.root.getBoundingClientRect();
    if (origin.bottom <= viewport.top || origin.top >= viewport.bottom || origin.right <= viewport.left || origin.left >= viewport.right) continue;
    if (!visitPublicationTextRangeRects(part, range, (rect) => {
      const left = Math.max(rect.left, viewport.left); const right = Math.min(rect.right, viewport.right);
      const top = Math.max(rect.top, viewport.top); const bottom = Math.min(rect.bottom, viewport.bottom);
      if (right <= left || bottom <= top) return true;
      refused = lease.reservePulseRect();
      if (refused !== null) return false;
      const node = document.createElement("span");
      node.className = "reader-source-pulse";
      node.setAttribute("aria-hidden", "true");
      node.dataset.nexusReaderOverlay = "source-pulse";
      node.style.left = `${left - origin.left}px`; node.style.top = `${top - origin.top}px`;
      node.style.width = `${right - left}px`; node.style.height = `${bottom - top}px`;
      node.addEventListener("animationend", completed); node.addEventListener("animationcancel", cancel);
      part.root.append(node); nodes.push(node);
      return true;
    })) { retire(false); return refused!; }
  }
  } catch (error) { retire(false); throw error; }
  signal.addEventListener("abort", cancel, { once: true });
  if (nodes.length === 0) retire(false);
  return { finished, release: cancel };
}
