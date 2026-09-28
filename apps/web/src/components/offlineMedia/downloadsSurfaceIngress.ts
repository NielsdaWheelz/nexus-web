"use client";

/**
 * One request ingress for "show me my downloads".
 *
 * The Downloads surface is composed above both offline capabilities, while the
 * account menu that asks for it lives outside that boundary. Routing the
 * request through one ingress keeps a single owner for the surface.
 */
type DownloadsOpenListener = () => void;

const listeners = new Set<DownloadsOpenListener>();

export function requestDownloadsOpen(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeDownloadsOpenRequest(
  listener: DownloadsOpenListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
