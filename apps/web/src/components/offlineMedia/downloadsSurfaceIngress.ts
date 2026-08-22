"use client";

/**
 * One request ingress for "show me my downloads".
 *
 * The Downloads surface is composed above both offline capabilities, while the
 * things that ask for it (the account menu, and the native audio bridge through
 * `OfflineMediaController.openDownloads`) live on either side of that
 * boundary. Routing the request through one ingress keeps a single owner for
 * the surface instead of one copy per capability.
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
