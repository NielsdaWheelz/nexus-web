// A module-level "reconcile now" channel between an app-level resource overlay
// and the resource-action runtime.
//
// The settings/subscribe overlays own their own mutations (an overlay, not the
// runtime's invoke wrapper, commits them), so they must be able to trigger a
// snapshot reconcile without importing the runtime — a decoupled module channel
// avoids a circular import between the overlay controller and the runtime and
// keeps the overlays independent of the runtime's mount position. When an
// overlay commits a state-changing mutation (e.g. subscribing flips
// PodcastSubscription) it publishes here; the runtime subscribes once and
// re-resolves every cached snapshot so each simultaneous representation agrees
// (AC7). Opening an overlay is not a mutation and must not publish.

type InvalidationListener = () => void;

const listeners = new Set<InvalidationListener>();

/** Ask the resource-action runtime to re-resolve every cached snapshot. */
export function publishResourceActionSnapshotInvalidation(): void {
  for (const listener of [...listeners]) listener();
}

/** Subscribe to invalidation requests; returns an unsubscribe. */
export function subscribeResourceActionSnapshotInvalidation(
  listener: InvalidationListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
