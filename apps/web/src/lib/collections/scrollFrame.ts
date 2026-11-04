import { flushSync } from "react-dom";

/** Runs `work` once per frame after any port scrolls or on request. Scroll events precede
 * rAF, and rAF precedes paint, but a rAF setState is default lane and lands after paint,
 * so `work` runs inside flushSync. Removing it leaves blank frames. */
export function scrollFrame(ports: readonly HTMLElement[], work: () => void): { request(): void; stop(): void } {
  let frame: number | null = null;
  const request = () => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      flushSync(work);
    });
  };
  for (const port of ports) port.addEventListener("scroll", request, { passive: true });
  return {
    request,
    stop() {
      if (frame !== null) cancelAnimationFrame(frame);
      for (const port of ports) port.removeEventListener("scroll", request);
    },
  };
}
