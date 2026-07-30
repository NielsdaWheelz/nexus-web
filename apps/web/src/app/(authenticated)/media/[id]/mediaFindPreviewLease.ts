export interface MediaFindPreviewLease {
  isActive(): boolean;
  beginSource(): void;
  acquire(): void;
  releaseForGenuineInput(): void;
  cancelUnreportedPreview(): void;
  retire(): void;
  subscribe(listener: () => void): () => void;
  armNextCaptureSuppression(): void;
  consumeNextCaptureSuppression(trustedIntent: boolean): boolean;
}

/**
 * One route-local fence shared by media Find, reader progress, and reading
 * activity. It deliberately owns no React state: consumers consult the
 * current value at their imperative mutation boundaries.
 */
export function createMediaFindPreviewLease(): MediaFindPreviewLease {
  let active = false;
  let retired = false;
  let suppressNextCapture = false;
  const listeners = new Set<() => void>();

  const publish = () => {
    for (const listener of listeners) listener();
  };

  return {
    isActive: () => active || retired,
    beginSource() {
      const changed = active || retired || suppressNextCapture;
      active = false;
      retired = false;
      suppressNextCapture = false;
      if (changed) publish();
    },
    acquire() {
      if (retired) return;
      suppressNextCapture = false;
      if (active) return;
      active = true;
      publish();
    },
    releaseForGenuineInput() {
      if (!active || retired) return;
      active = false;
      publish();
    },
    cancelUnreportedPreview() {
      if (!active || retired) return;
      active = false;
      publish();
    },
    retire() {
      suppressNextCapture = false;
      if (retired) return;
      retired = true;
      publish();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    armNextCaptureSuppression() {
      suppressNextCapture = true;
    },
    consumeNextCaptureSuppression(trustedIntent) {
      if (!suppressNextCapture) return false;
      suppressNextCapture = false;
      return !trustedIntent;
    },
  };
}
