// The cursor: where the reader intends to resume. Revision is authority (the
// port compares and sets). Movement saves after 500ms idle, at most 5s after
// the first unsaved move, one request in flight, latest locator only.
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
  | { readonly kind: "LoadFailed"; readonly error: unknown }
  | {
      readonly kind: "Ready";
      readonly view: ProgressView;
      readonly saving: boolean;
      readonly saveFailed: boolean;
      readonly handoff: Handoff | null;
    };

export interface ProgressSync {
  state(): ProgressState;
  /** null: the cursor could not be read (LoadFailed); the document opens anyway. */
  start(signal: AbortSignal): Promise<ProgressView | null>;
  report(locator: Locator): void;
  flush(keepalive: boolean): Promise<void>;
  revalidate(): Promise<void>;
  install(snapshot: CursorSnapshot): void;
  resolve(choice: "Canonical" | "Device"): Promise<void>;
  retry(): void;
  stop(): void;
}

/** The snapshot a view positions at: canonical, or the device position over its baseline. */
export function savedLocator(view: ProgressView): Locator | null {
  if (view.kind !== "Canonical") return view.device;
  return view.snapshot.state === "Positioned" ? view.snapshot.locator : null;
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
  const anchor = (l: typeof a) =>
    l.kind === "epub" && l.target.anchor_id.kind === "Present"
      ? l.target.anchor_id.value
      : null;
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
    /** Position the reader at a snapshot it adopted (newer elsewhere, or chosen). */
    remote(snapshot: CursorSnapshot): void;
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
  let failed = false;
  let inFlight: Promise<void> | null = null;
  let revalidating = false;
  let dirtySince = 0;
  let movedAt = 0;
  let timer: number | undefined;

  const publish = () => {
    state =
      view === null
        ? state
        : {
            kind: "Ready",
            view,
            saving: inFlight !== null,
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
      view === null
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
    const run = async () => {
      try {
        const result = await port.save(locator, {
          revision: base().revision,
          keepalive,
        });
        failed = false;
        if (result.kind === "Stale") {
          // The locator stays unsaved: keeping my spot saves it over the newer one.
          handoff = { kind: "Newer", snapshot: result.canonical };
          return;
        }
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
        console.error("reader_cursor_save_failed", error);
        failed = true;
      } finally {
        inFlight = null;
        publish();
        if (!failed) schedule();
      }
    };
    inFlight = run();
    publish();
    return inFlight;
  }

  async function revalidate() {
    if (view === null || revalidating) return;
    revalidating = true;
    try {
      const next = await port.load();
      if (next.kind !== "Canonical") {
        adopt(next);
      } else if (next.snapshot.revision > base().revision) {
        const { snapshot } = next;
        const ours = (locator: Locator | null) =>
          locator !== null &&
          snapshot.state === "Positioned" &&
          sameLocator(snapshot.locator, locator);
        // Our own position arriving back (a failed save that committed, a device sync)
        // only advances the base; someone else's moves us only while we are away.
        const pending = ours(unsaved);
        const own = pending || ours(savedLocator(view));
        // Judged after the load: input during it makes the reader present.
        const dormant = hooks.dormant() && unsaved === null && handoff === null;
        if (own || dormant) {
          view = next;
          if (pending) {
            unsaved = null;
            failed = false;
          }
          if (!own) hooks.remote(snapshot);
        } else handoff = { kind: "Newer", snapshot };
      }
    } catch (error) {
      console.error("reader_cursor_revalidate_failed", error);
    } finally {
      revalidating = false;
      publish();
    }
  }

  return {
    state: () => state,
    async start(signal) {
      try {
        const loaded = await port.load(signal);
        handoff = null;
        adopt(loaded);
        publish();
        schedule();
        return loaded;
      } catch (error) {
        if (!signal.aborted) {
          state = { kind: "LoadFailed", error };
          hooks.changed();
        }
        return null;
      }
    },
    report(locator) {
      const current = unsaved ?? (view === null ? null : savedLocator(view));
      if (current !== null && sameLocator(current, locator)) return;
      if (unsaved === null) dirtySince = Date.now();
      movedAt = Date.now();
      unsaved = locator;
      failed = false;
      schedule();
    },
    async flush(keepalive) {
      window.clearTimeout(timer);
      await inFlight;
      if (handoff?.kind !== "Newer") await save(keepalive);
    },
    revalidate,
    install(snapshot) {
      window.clearTimeout(timer);
      view = { kind: "Canonical", snapshot };
      handoff = null;
      unsaved = null;
      failed = false;
      publish();
    },
    async resolve(choice) {
      const open = handoff;
      if (open === null) return;
      if (open.kind === "Newer") {
        view = { kind: "Canonical", snapshot: open.snapshot };
        handoff = null;
        if (choice === "Canonical") {
          unsaved = null;
          failed = false;
          publish();
          hooks.remote(open.snapshot);
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
          if (choice === "Canonical") hooks.remote(current.canonical);
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
      void revalidate().then(() => {
        if (failed && handoff?.kind !== "Newer") void save(false);
      });
    },
    stop() {
      window.clearTimeout(timer);
    },
  };
}
