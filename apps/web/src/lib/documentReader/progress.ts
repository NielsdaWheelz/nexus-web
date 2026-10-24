// The cursor: where the reader intends to resume. Revision is authority (the
// port compares and sets). Movement saves after 500ms idle, at most 5s after
// the first unsaved move, one request in flight, latest locator only.
// Command preparation holds acknowledged progress only; refusal releases its hold
// while preserving the local locator and the owner’s save/conflict recovery.
import { ProgressPreparationError } from "@/lib/consumption/progressFence";
import type { CursorSnapshot, Locator } from "./model";
import type { ProgressView, ReaderProgressPort } from "./ports";

export const SAVE_IDLE_MS = 500;
export const SAVE_MAX_WAIT_MS = 5_000;

export type Handoff =
  /** Canonical moved past the base (revalidated, or a save refused): movement waits for the choice. */
  | { readonly kind: "Newer"; readonly snapshot: CursorSnapshot }
  /** A device store holds two positions: reading keeps moving the device side until the choice. */
  | {
      readonly kind: "Conflict";
      readonly canonical: CursorSnapshot;
      readonly device: Locator;
    };
export type ProgressState =
  | { readonly kind: "Loading" }
  | {
      readonly kind: "LoadFailed";
      readonly recovery: "RetryPosition" | "ReloadDocument";
      readonly retrying: boolean;
      readonly error: unknown;
    }
  | {
      readonly kind: "Ready";
      readonly view: ProgressView;
      readonly saving: boolean;
      readonly retrying: boolean;
      readonly saveFailed: boolean;
      readonly handoff: Handoff | null;
    };

export interface ProgressSync {
  state(): ProgressState;
  /** Bind an initial/replacement publication; retire old saves. null: failed or superseded binding. */
  start(signal: AbortSignal): Promise<ProgressView | null>;
  report(locator: Locator, adoption?: { readonly adoptUnresolved: true }): void;
  flush(keepalive: boolean): Promise<void>;
  revalidate(): Promise<void>;
  prepareFence(): Promise<void>;
  reconcileFence(): Promise<void>;
  install(snapshot: CursorSnapshot): void;
  resolve(choice: "Canonical" | "Device"): Promise<void>;
  retry(): void;
  stop(): void;
}

/** The snapshot a view positions at: canonical, or the device position over its baseline. */
export function savedLocator(view: ProgressView): Locator | null {
  if (unresolvedPosition(view)) return null;
  if (view.kind !== "Canonical") return view.device;
  return view.snapshot.state === "Positioned" ? view.snapshot.locator : null;
}

/** Unresolved evidence stays authoritative even when an offline device has a stale position. */
export function unresolvedPosition(view: ProgressView): Extract<CursorSnapshot, { state: "Unresolved" }> | null {
  if (view.kind === "Pending" && view.adoptUnresolved) return null;
  const snapshot = view.kind === "Canonical" ? view.snapshot : view.kind === "Conflict" ? view.canonical : view.baseline;
  return snapshot.state === "Unresolved" ? snapshot : null;
}

function sameLocator(a: Locator, b: Locator): boolean {
  if (a.kind === "pdf" || b.kind === "pdf") {
    return (
      a.kind === "pdf" &&
      b.kind === "pdf" &&
      a.page === b.page &&
      a.page_progression === b.page_progression &&
      a.zoom === b.zoom
    );
  }
  if (a.kind === "x" || b.kind === "x") return a.kind === "x" && b.kind === "x" &&
    a.occurrence_id === b.occurrence_id && a.post_media_id === b.post_media_id &&
    a.source_revision_id === b.source_revision_id && JSON.stringify(a.locations) === JSON.stringify(b.locations);
  const anchor = (l: typeof a) => (l.kind === "epub" ? l.target.anchor_id : null);
  return (
    a.kind === b.kind &&
    a.target.fragment_id === b.target.fragment_id &&
    a.locations.text_offset === b.locations.text_offset &&
    a.locations.total_progression === b.locations.total_progression &&
    anchor(a) === anchor(b)
  );
}

export function createProgressSync(
  port: ReaderProgressPort,
  hooks: {
    changed(): void;
    generation(): number | null;
    /** Retire prior input on observed authority; reposition only when its spot differs. */
    remote(snapshot: CursorSnapshot, move: boolean): void;
    /** The reader is away and idle: a newer cursor may be adopted silently. */
    dormant(): boolean;
    /** The reading spot to keep when the user keeps theirs over a newer one. */
    reading(): Locator | null;
  },
): ProgressSync {
  let state: ProgressState = { kind: "Loading" };
  let view: ProgressView | null = null;
  let handoff: Handoff | null = null;
  let unsaved: Locator | null = null;
  let adopting = false;
  let failed = false;
  /** The page is going away (a keepalive flush): a save it cuts off is no failure. */
  let leaving = false;
  let inFlight: Promise<void> | null = null;
  let revalidating = false;
  let dirtySince = 0;
  let movedAt = 0;
  let timer: number | undefined;
  let fenced = false;
  let generation = 0;
  // A genuine same-position input after load/unread still needs one accepted save.
  let activitySaved = false;
  const needsSourceBinding = () => fenced && (
    state.kind === "Loading" ||
    (state.kind === "LoadFailed" && state.recovery === "ReloadDocument")
  );
  const requireSourceReload = () => {
    view = null;
    failed = false;
    fenced = true;
    state = {
      kind: "LoadFailed",
      recovery: "ReloadDocument",
      retrying: false,
      error: state.kind === "LoadFailed" ? state.error : new Error("source reload required"),
    };
  };

  const publish = () => {
    state =
      view === null || (fenced && state.kind !== "Ready")
        ? state
        : {
            kind: "Ready",
            view,
            saving: inFlight !== null,
            retrying: revalidating,
            saveFailed: failed,
            handoff,
          };
    hooks.changed();
  };
  const base = (): CursorSnapshot =>
    view === null
      ? { state: "Empty", revision: 0 }
      : view.kind === "Canonical"
        ? view.snapshot
        : view.kind === "Conflict"
          ? view.canonical
          : view.baseline;
  const adopt = (next: ProgressView) => {
    view = next;
    handoff =
      next.kind === "Conflict"
        ? { kind: "Conflict", canonical: next.canonical, device: next.device }
        : handoff?.kind === "Conflict"
          ? null
          : handoff;
  };

  function schedule() {
    window.clearTimeout(timer);
    if (
      unsaved === null ||
      inFlight !== null ||
      handoff?.kind === "Newer" ||
      view === null ||
      fenced
    )
      return;
    const due = Math.min(movedAt + SAVE_IDLE_MS, dirtySince + SAVE_MAX_WAIT_MS);
    timer = window.setTimeout(
      () => void save(false),
      Math.max(0, due - Date.now()),
    );
  }

  function save(keepalive: boolean): Promise<void> {
    window.clearTimeout(timer);
    const locator = unsaved;
    if (inFlight !== null || locator === null || view === null)
      return inFlight ?? Promise.resolve();
    // A save the leaving page cut off (or a keepalive one, which outlives it)
    // has an unobservable outcome: the locator stays unsaved, no retry here.
    let cutOff = false;
    const run = async () => {
      try {
        const result = await port.save(locator, {
          revision: base().revision,
          keepalive,
          expectedReaderGeneration: hooks.generation(),
          adoptUnresolved: adopting,
        });
        if (needsSourceBinding()) return;
        if (result.kind === "ContentChanged") {
          unsaved = null;
          requireSourceReload();
          return;
        }
        failed = false;
        if (result.kind === "Stale") {
          if (result.canonical.state === "Unresolved") {
            view = { kind: "Canonical", snapshot: result.canonical };
            unsaved = null;
            adopting = false;
            handoff = null;
            hooks.remote(result.canonical, false);
            return;
          }
          // The locator stays unsaved: keeping my spot saves it over the newer one.
          if (result.canonical.revision > base().revision &&
              (handoff?.kind !== "Newer" || result.canonical.revision > handoff.snapshot.revision))
            handoff = { kind: "Newer", snapshot: result.canonical };
          return;
        }
        if (result.kind === "Canonical" && result.snapshot.revision < base().revision) return;
        activitySaved = true;
        adopting = false;
        // A binding/command fence has already invalidated earlier reads.
        if (!fenced) generation += 1;
        if (unsaved === locator) unsaved = null;
        if (result.kind === "Device") adopt(result.view);
        else {
          view = { kind: "Canonical", snapshot: result.snapshot };
          if (
            handoff?.kind === "Newer" &&
            handoff.snapshot.revision <= result.snapshot.revision
          ) {
            handoff = null;
          }
        }
      } catch (error) {
        if (needsSourceBinding()) return;
        cutOff = keepalive || leaving;
        if (!cutOff) {
          console.error("reader_cursor_save_failed", error);
          failed = true;
        }
      } finally {
        inFlight = null;
        publish();
        if (!failed && !cutOff) schedule();
      }
    };
    inFlight = run();
    publish();
    return inFlight;
  }

  async function revalidate() {
    if (state.kind === "LoadFailed" && state.retrying) return;
    if (fenced) {
      if (failed) await reconcileFence().catch((error: unknown) => console.error("reader_cursor_reconcile_failed", error));
      return;
    }
    if (view === null || revalidating) return;
    revalidating = true;
    publish();
    const mine = generation;
    const candidate = unsaved;
    try {
      const next = await port.load();
      if (mine !== generation) return;
      if (next.kind !== "Canonical") {
        adopt(next);
      } else if (view.kind !== "Canonical" && unsaved === null &&
                 next.snapshot.revision === base().revision && next.snapshot.state === "Positioned" &&
                 sameLocator(next.snapshot.locator, view.device)) {
        // An equal-position device save can be accepted without moving the cursor revision.
        view = next;
        handoff = null;
        failed = false;
      } else if (next.snapshot.revision > base().revision) {
        const { snapshot } = next;
        if (snapshot.state === "Unresolved") {
          view = next;
          unsaved = null;
          adopting = false;
          handoff = null;
          hooks.remote(snapshot, false);
          return;
        }
        const ours = (locator: Locator | null) =>
          locator !== null &&
          snapshot.state === "Positioned" &&
          sameLocator(snapshot.locator, locator);
        // Our own position arriving back (a failed save that committed, a device sync)
        // only advances the base; someone else's moves us only while we are away.
        const pending = candidate !== null && candidate === unsaved && ours(candidate);
        const own = pending || (unsaved === null && ours(savedLocator(view)));
        // Judged after the load: input during it makes the reader present.
        const dormant = hooks.dormant() && unsaved === null && handoff === null;
        if (own || dormant) {
          view = next;
          activitySaved = false;
          if (pending) {
            unsaved = null;
            failed = false;
          }
          hooks.remote(snapshot, !own);
          if (handoff?.kind === "Newer" && handoff.snapshot.revision <= snapshot.revision) handoff = null;
        } else handoff = { kind: "Newer", snapshot };
      }
    } catch (error) {
      console.error("reader_cursor_revalidate_failed", error);
    } finally {
      revalidating = false;
      publish();
    }
  }

  async function reconcileFence() {
    // A cancelled source binding requires a source reload, not a cursor-only retry.
    if (needsSourceBinding() || !fenced || unsaved !== null) return;
    const mine = ++generation;
    if (state.kind === "LoadFailed") {
      state = { ...state, retrying: true };
      publish();
    }
    try {
      const next = await port.load();
      if (mine !== generation) return;
      adopt(next);
      handoff = next.kind === "Conflict" ? handoff : null;
      unsaved = null;
      failed = false;
      fenced = false;
      activitySaved = false;
      if (next.kind === "Canonical") hooks.remote(next.snapshot, true);
    } catch (error) {
      if (mine === generation) {
        // Reconciliation reads own load failures; the fence keeps saves paused.
        failed = true;
        state = { kind: "LoadFailed", recovery: "RetryPosition", retrying: false, error };
      }
      throw error;
    } finally {
      publish();
    }
  }

  return {
    state: () => state,
    async start(signal) {
      if (signal.aborted) return null;
      const mine = ++generation;
      fenced = true;
      window.clearTimeout(timer);
      unsaved = null;
      adopting = false;
      failed = false;
      handoff = null;
      state = state.kind === "LoadFailed"
        ? { ...state, recovery: "ReloadDocument", retrying: true }
        : { kind: "Loading" };
      publish();
      await inFlight;
      if (mine !== generation) return null;
      view = null;
      failed = false;
      handoff = null;
      activitySaved = false;
      try {
        signal.throwIfAborted();
        const loaded = await port.load(signal);
        if (mine !== generation) return null;
        signal.throwIfAborted();
        adopt(loaded);
        fenced = false;
        publish();
        return loaded;
      } catch (error) {
        if (mine === generation) {
          failed = !signal.aborted;
          state = {
            kind: "LoadFailed",
            recovery: signal.aborted ? "ReloadDocument" : "RetryPosition",
            retrying: false,
            error: signal.aborted ? signal.reason : error,
          };
          publish();
        }
        return null;
      }
    },
    report(locator, adoption) {
      if (fenced || (view && unresolvedPosition(view) && !adoption)) return;
      adopting ||= adoption?.adoptUnresolved === true;
      const current = unsaved ?? (view === null ? null : savedLocator(view));
      if (current !== null && sameLocator(current, locator) && (unsaved !== null || activitySaved)) return;
      if (unsaved === null) dirtySince = Date.now();
      movedAt = Date.now();
      unsaved = locator;
      failed = false;
      leaving = false;
      schedule();
    },
    async flush(keepalive) {
      if (fenced) return;
      window.clearTimeout(timer);
      leaving ||= keepalive;
      await inFlight;
      if (handoff?.kind !== "Newer") await save(keepalive);
    },
    revalidate,
    async prepareFence() {
      if (needsSourceBinding()) requireSourceReload();
      fenced = true;
      generation += 1;
      window.clearTimeout(timer);
      await inFlight;
      if (handoff?.kind !== "Newer") await save(false);
      if (needsSourceBinding() || unsaved !== null || view?.kind !== "Canonical" || handoff !== null) {
        // Source reloads retain their own fence; a command failure releases only its hold.
        if (!needsSourceBinding()) fenced = false;
        publish();
        throw new ProgressPreparationError();
      }
      failed = false;
      publish();
    },
    reconcileFence,
    install(snapshot) {
      const sourceBinding = needsSourceBinding();
      generation += 1;
      window.clearTimeout(timer);
      if (sourceBinding) requireSourceReload();
      else {
        view = { kind: "Canonical", snapshot };
        fenced = false;
      }
      handoff = null;
      unsaved = null;
      adopting = false;
      failed = false;
      activitySaved = false;
      publish();
    },
    async resolve(choice) {
      if (fenced) return;
      const open = handoff;
      if (open === null) return;
      if (open.kind === "Newer") {
        view = { kind: "Canonical", snapshot: open.snapshot };
        handoff = null;
        if (choice === "Canonical") {
          unsaved = null;
          failed = false;
          publish();
          hooks.remote(open.snapshot, true);
          return;
        }
        unsaved = hooks.reading() ?? unsaved;
        publish();
        await save(false);
        return;
      }
      // The store settles its conflict; "Device" keeps the spot being read. The
      // resolution holds the one flight, so no save lands on either side of it.
      window.clearTimeout(timer);
      while (inFlight) await inFlight;
      const current = handoff;
      if (current?.kind !== "Conflict") return;
      const device = unsaved ?? current.device;
      const run = async () => {
        try {
          adopt(
            await port.resolve(choice, {
              canonical: current.canonical,
              device,
            }),
          );
          if (choice === "Canonical" || unsaved === device) unsaved = null;
          failed = false;
          if (choice === "Canonical") hooks.remote(current.canonical, true);
        } catch (error) {
          console.error("reader_cursor_resolve_failed", error);
          failed = true;
        } finally {
          inFlight = null;
          publish();
          if (!failed) schedule();
        }
      };
      inFlight = run();
      publish();
      await inFlight;
    },
    retry() {
      if (fenced) {
        if (failed) void reconcileFence().catch((error: unknown) => console.error("reader_cursor_reconcile_failed", error));
        return;
      }
      void revalidate().then(() => {
        if (failed && handoff?.kind !== "Newer") void save(false);
      });
    },
    stop() {
      generation += 1;
      window.clearTimeout(timer);
    },
  };
}
