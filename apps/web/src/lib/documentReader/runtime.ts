// One reader instance: it loads the publication and the cursor together,
// restores once a surface is attached, owns reading mode and the cursor sync,
// and keeps the latest measured viewport. A plain object; React reads it
// through subscribe/getState.
import {
  clampZoom,
  locatorAt,
  structureOf,
  targetOfLocator,
  type CursorSnapshot,
  type Locator,
  type Placement,
  type ReaderDocument,
  type ReaderPoint,
  type ReaderTarget,
  type Structure,
  type Viewport,
} from "./model";
import {
  createNavigator,
  type NavOutcome,
  type NavState,
  type Positioner,
} from "./navigator";
import type { FindSource } from "@/lib/find/find";
import type { ReaderHost, ReaderProgressPort, ReaderSource } from "./ports";
import {
  createProgressSync,
  savedLocator,
  type ProgressState,
} from "./progress";

export interface ReaderEntry {
  /** Fresh target (hash, pulse, passage, apparatus): beats the saved cursor. */
  readonly fresh: Promise<ReaderTarget | null> | null;
  /** Cold target (?loc, ?fragment): used only when there is no saved cursor. */
  readonly cold: ReaderTarget | null;
}
export interface ReaderOptions {
  readonly source: ReaderSource;
  /** null: read-only, no status strip. */
  readonly progress: ReaderProgressPort | null;
  readonly entry: ReaderEntry;
  readonly host?: ReaderHost;
}
export interface PdfState {
  readonly page: number;
  readonly pages: number;
  /** null: fitted to the width, wherever the pdf opens next. */
  readonly zoom: number | null;
  /** The rendered scale, fitted or chosen. */
  readonly scale: number;
  readonly widthPx: number;
}
export interface ReaderState {
  readonly document:
    | { readonly status: "loading" }
    | { readonly status: "failed"; readonly error: unknown }
    | {
        readonly status: "ready";
        readonly doc: ReaderDocument;
        readonly structure: Structure;
      };
  readonly viewport: Viewport | null;
  readonly navigation: NavState;
  readonly progress: ProgressState | null;
  readonly pdf: PdfState | null;
  readonly restored: boolean;
  readonly savedSpotUnavailable: boolean;
  /** The attached surface's find, keyed by the publication it searches. */
  readonly find: FindSource<unknown> | null;
}
export interface Reader {
  getState(): ReaderState;
  subscribe(listener: () => void): () => void;
  inspect(target: ReaderTarget): Promise<NavOutcome>;
  returnToSpot(): Promise<NavOutcome>;
  continueHere(): void;
  resolveHandoff(choice: "Canonical" | "Device"): Promise<void>;
  retrySave(): void;
  retryLoad(): void;
  /** Host: pane activation. */
  revalidate(): void;
  /** Host: publication and processing events, E_READER_CONTENT_CHANGED. */
  reload(): void;
  prepareProgressFence(): Promise<void>;
  reconcileProgressFence(): Promise<void>;
  install(snapshot: CursorSnapshot): void;
  /** pdf; clamped to PDF_ZOOM. */
  setZoom(zoom: number): void;
  /** The reader chose to read from a point (a transcript time): it becomes the cursor. */
  readFrom(point: ReaderPoint): void;
}
export interface SurfaceHandle extends Positioner {
  readonly find: FindSource<unknown>;
  setZoom?(zoom: number): void;
}
export interface ReaderRuntime extends Reader {
  readonly source: ReaderSource;
  readonly host: ReaderHost | undefined;
  /** Loads and runs until the returned unmount; may mount again. */
  mount(): () => void;
  attach(surface: SurfaceHandle): () => void;
  viewport(
    viewport: Omit<Viewport, "identity" | "intent">,
    pdf?: PdfState,
  ): void;
  /** Genuine user input only. */
  input(direction: "forward" | "backward" | "none"): void;
  seek(): { settle(moved: boolean): void; cancel(): void } | null;
  /** The window lost the user: blurred (flush false) or hidden (flush true). */
  away(flush: boolean): void;
}

/** Genuine input this recent makes a viewport the reader's own. */
const READER_INTENT_MS = 1_000;

export function createReaderRuntime(options: ReaderOptions): ReaderRuntime {
  let state: ReaderState = {
    document: { status: "loading" },
    viewport: null,
    navigation: {
      mode: "Reading",
      origin: null,
      originUnavailable: false,
      positioning: false,
      failure: null,
    },
    progress: options.progress && { kind: "Loading" },
    pdf: null,
    restored: false,
    savedSpotUnavailable: false,
    find: null,
  };
  const listeners = new Set<() => void>();
  let surface: SurfaceHandle | null = null;
  let loading: AbortController | null = null;
  let restore: { fresh: ReaderTarget | null; saved: Locator | null } | null =
    null;
  let freshUsed = false;
  let input = {
    at: -Infinity,
    direction: "none" as "forward" | "backward" | "none",
  };
  let inputSinceLoad = false;
  let isAway = false;
  let releaseChrome: (() => void) | null = null;

  const set = (patch: Partial<ReaderState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const ready = () =>
    state.document.status === "ready" ? state.document : null;
  const locator = (placement: Placement, terminal = false): Locator | null => {
    const doc = ready();
    return (
      doc &&
      locatorAt(doc.doc, doc.structure, placement.point, {
        terminal,
        zoom: placement.zoom,
      })
    );
  };

  const navigator = createNavigator(() => surface, {
    changed() {
      const navigation = navigator.state();
      if (navigation.positioning && !releaseChrome)
        releaseChrome = options.host?.holdChrome?.() ?? null;
      if (!navigation.positioning && releaseChrome) {
        const release = releaseChrome;
        releaseChrome = null;
        release();
      }
      set({ navigation });
    },
    beforeExplore: () => void sync?.flush(false),
    locate: (saved) => {
      const doc = ready();
      return doc && targetOfLocator(doc.doc, saved);
    },
  });
  const sync =
    options.progress &&
    createProgressSync(options.progress, {
      changed: () => set({ progress: sync!.state() }),
      remote(snapshot, move) {
        input = { at: -Infinity, direction: "none" };
        if (move) void applySnapshot(snapshot);
      },
      dormant: () =>
        isAway &&
        state.navigation.mode === "Reading" &&
        !state.navigation.positioning,
      reading() {
        const { origin } = state.navigation;
        if (origin?.kind === "saved") return origin.locator;
        const placement = origin?.placement ?? surface?.capture() ?? null;
        return placement && locator(placement);
      },
    });

  async function applySnapshot(snapshot: CursorSnapshot) {
    input = { at: -Infinity, direction: "none" };
    const doc = ready();
    if (!doc) return;
    const target: ReaderTarget | null =
      snapshot.state === "Positioned"
        ? targetOfLocator(doc.doc, snapshot.locator)
        : { kind: "edge", edge: "start" };
    if (target) await navigator.apply(target);
  }

  async function load() {
    loading?.abort();
    const controller = new AbortController();
    loading = controller;
    const previous = ready()?.doc ?? null;
    if (!previous) set({ document: { status: "loading" } });
    try {
      const [doc, view, fresh] = await Promise.all([
        options.source.load(controller.signal),
        sync?.start(controller.signal) ?? null,
        freshUsed ? null : options.entry.fresh,
      ]);
      if (controller.signal.aborted) return;
      freshUsed = true;
      if (previous?.identity === doc.identity) return;
      if (previous) navigator.invalidateOrigin(doc.identity);
      restore = { fresh: fresh ?? null, saved: view && savedLocator(view) };
      set({
        document: {
          status: "ready",
          doc,
          structure: structureOf(doc, doc.kind === "pdf" ? doc.pages : null),
        },
        viewport: null,
        restored: false,
        savedSpotUnavailable: false,
      });
      void restoreOnce();
    } catch (error) {
      if (!controller.signal.aborted && !previous)
        set({ document: { status: "failed", error } });
    }
  }

  /** Fresh target, else the saved cursor, else the cold target, else the start. */
  async function restoreOnce() {
    const doc = ready();
    const pending = restore;
    if (!doc || !pending || !surface) return;
    restore = null;
    if (!inputSinceLoad) {
      const { fresh, saved } = pending;
      if (saved?.kind === "pdf" && saved.zoom !== null)
        surface.setZoom?.(clampZoom(saved.zoom));
      const savedTarget = saved && targetOfLocator(doc.doc, saved);
      if (fresh) await navigator.enter(fresh, saved);
      else if (savedTarget) await navigator.apply(savedTarget);
      else if (saved) set({ savedSpotUnavailable: true });
      else if (options.entry.cold) await navigator.apply(options.entry.cold);
    }
    set({ restored: true });
  }

  return {
    source: options.source,
    host: options.host,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    mount() {
      inputSinceLoad = false;
      void load();
      return () => {
        loading?.abort();
        navigator.cancel();
        void sync?.flush(true);
        sync?.stop();
        releaseChrome?.();
        releaseChrome = null;
      };
    },
    attach(handle) {
      surface = handle;
      set({ find: handle.find });
      void restoreOnce();
      return () => {
        if (surface !== handle) return;
        surface = null;
        set({ find: null });
      };
    },
    viewport(measured, pdf) {
      const doc = ready();
      if (!doc) return;
      const { positioning, mode } = state.navigation;
      const reading =
        performance.now() - input.at < READER_INTENT_MS && !positioning;
      const viewport: Viewport = {
        ...measured,
        identity: doc.doc.identity,
        intent: reading ? "reader" : "programmatic",
      };
      // A pdf without a recorded page count learns it when it opens.
      const structure =
        pdf && pdf.pages !== doc.structure.length
          ? structureOf(doc.doc, pdf.pages)
          : null;
      set({
        viewport,
        ...(pdf ? { pdf } : {}),
        ...(structure ? { document: { ...doc, structure } } : {}),
      });
      if (!reading || mode !== "Reading" || !state.restored || !sync) return;
      // Reading on makes a new spot; the lost one is no longer news.
      if (state.savedSpotUnavailable) set({ savedSpotUnavailable: false });
      const terminal = measured.atEnd && input.direction === "forward";
      sync.report(
        locatorAt(doc.doc, doc.structure, measured.primary, {
          terminal,
          zoom: pdf?.zoom ?? null,
        }),
      );
    },
    input(direction) {
      input = { at: performance.now(), direction };
      inputSinceLoad = true;
      isAway = false;
      if (state.navigation.positioning) navigator.cancel();
    },
    seek: () => navigator.seek(),
    away(flush) {
      isAway = true;
      if (flush) void sync?.flush(true);
    },
    inspect: (target) => navigator.inspect(target),
    returnToSpot: () => navigator.returnToSpot(),
    continueHere() {
      const placement = navigator.continueHere();
      const adopted = placement && locator(placement);
      if (adopted) sync?.report(adopted);
    },
    resolveHandoff: async (choice) => sync?.resolve(choice),
    retrySave: () => sync?.retry(),
    retryLoad: () => void load(),
    revalidate() {
      void sync?.revalidate().finally(() => {
        isAway = false;
      });
    },
    reload: () => void load(),
    async prepareProgressFence() {
      input = { at: -Infinity, direction: "none" };
      await sync?.prepareFence();
    },
    reconcileProgressFence: async () => sync?.reconcileFence(),
    install(snapshot) {
      sync?.install(snapshot);
      void applySnapshot(snapshot);
    },
    setZoom: (zoom) => surface?.setZoom?.(clampZoom(zoom)),
    readFrom(point) {
      const doc = ready();
      if (!doc) return;
      // Not genuine input: the viewport, wherever it is, must not overwrite this point.
      inputSinceLoad = true;
      navigator.continueHere();
      sync?.report(
        locatorAt(doc.doc, doc.structure, point, {
          terminal: false,
          zoom: null,
        }),
      );
    },
  };
}
