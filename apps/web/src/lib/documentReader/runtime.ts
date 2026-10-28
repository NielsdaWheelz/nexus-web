// One reader instance: it loads the publication and the cursor together,
// restores once a surface is attached, owns reading mode and the cursor sync,
// and keeps the viewport and placement from one surface measurement. A plain
// object; React reads it through subscribe/getState. Explicit navigation and
// reading announce intent before work; automatic restore and reflow remain local.
import type { PassageState } from "@nexus/authored/types";
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
  type NavigationFailure,
  type NavSnapshot,
  type NavState,
  type Positioner,
} from "./navigator";
import type { FindSource } from "@/lib/find/find";
import type { Passage, PassageGeometry, SelectionEvent } from "./DocumentReader";
import type { ReaderHost, ReaderNavigationPort, ReaderProgressPort, ReaderSource } from "./ports";
import type { PdfFindDestination } from "./location";
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
  readonly view?: ReaderViewSnapshot | null;
}
export interface ReaderViewSnapshot {
  readonly identity: string;
  readonly placement: Placement;
  readonly navigation: NavSnapshot;
}
export interface ReaderOptions {
  readonly source: ReaderSource;
  /** null: read-only, no status strip. */
  readonly progress: ReaderProgressPort | null;
  readonly entry: ReaderEntry;
  readonly host?: ReaderHost;
}
export interface PdfState {
  /** The page at the reading line, shared with viewport.primary. */
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
    | { readonly status: "failed"; readonly error: unknown; readonly retrying: boolean }
    | {
        readonly status: "ready";
        readonly doc: ReaderDocument;
        readonly structure: Structure;
        readonly refreshing: boolean;
        readonly refreshFailure: { readonly error: unknown } | null;
      };
  readonly viewport: Viewport | null;
  /** The pixel placement from the same measurement as viewport; no geometry read. */
  readonly placement: Placement | null;
  readonly navigation: NavState;
  readonly progress: ProgressState | null;
  readonly pdf: PdfState | null;
  readonly restored: boolean;
  /** The exact visit snapshot attempted against this publication; readiness alone is insufficient. */
  readonly viewRestoration: {
    readonly snapshot: ReaderViewSnapshot | null;
    readonly sourceIdentity: string;
    readonly outcome: "Restored" | "Absent" | "Failed";
  } | null;
  readonly savedSpotUnavailable: boolean;
  /** The attached surface's find, keyed by the publication it searches. */
  readonly find: FindSource<unknown> | null;
}
export interface Reader {
  readonly navigation: ReaderNavigationPort | null;
  getState(): ReaderState;
  subscribe(listener: () => void): () => void;
  measurePassage(passage: Passage): PassageGeometry | null;
  measureBounds(): DOMRect | null;
  /** Capture the current native range through the mounted publication's surface. */
  captureSelection(): SelectionEvent | null;
  /** Return focus to the source without moving its reading position. */
  focusSource(): void;
  captureView(): ReaderViewSnapshot | null;
  restoreView(snapshot: ReaderViewSnapshot, signal?: AbortSignal): Promise<NavOutcome>;
  /** Revalidate retained PDF inspection paint without replaying its movement. */
  restorePdfFind(target: PdfFindDestination, signal: AbortSignal): Promise<boolean>;
  /** Resolve a saved quote through the mounted pdf owner, without changing find. */
  locatePdfPassage(passage: PassageState, signal: AbortSignal): Promise<number | null>;
  inspect(input: {
    readonly target: ReaderTarget | ((signal: AbortSignal) => ReaderTarget | null | Promise<ReaderTarget | null>);
    readonly signal?: AbortSignal;
  }): Promise<NavOutcome>;
  returnToSpot(): Promise<NavOutcome>;
  continueHere(): void;
  dismissNavigationFailure(expected: NavigationFailure): void;
  retireNavigationAttempt(): void;
  resolveHandoff(choice: "Canonical" | "Device"): Promise<void>;
  retrySave(): void;
  retryLoad(): void;
  /** Host: pane activation. */
  revalidate(): void;
  /** Host: publication and processing events, E_READER_CONTENT_CHANGED. */
  reload(generation?: number): void;
  prepareProgressFence(): Promise<void>;
  reconcileProgressFence(): Promise<void>;
  install(snapshot: CursorSnapshot): void;
  /** pdf; numeric zoom is clamped to PDF_ZOOM, null fits the pane width. */
  setZoom(zoom: number | null): void;
  /** The reader chose to read from a point (a transcript time): it becomes the cursor. */
  readFrom(point: ReaderPoint): void;
}
export interface SurfaceHandle extends Positioner {
  readonly identity: string;
  readonly find: FindSource<unknown>;
  measurePassage(passage: Passage): PassageGeometry | null;
  measureBounds(): DOMRect | null;
  captureSelection(): SelectionEvent | null;
  focusSource(): void;
  /** A newer intent retires geometry queued before the navigator admitted work. */
  retireReflow(): void;
  setZoom?(zoom: number | null): void;
  restorePdfFind?(target: PdfFindDestination, signal: AbortSignal): Promise<boolean>;
  locatePdfPassage?(passage: PassageState, signal: AbortSignal): Promise<number | null>;
}
export interface ReaderRuntime extends Reader {
  readonly source: ReaderSource;
  readonly host: ReaderHost | undefined;
  /** Loads and runs until the returned unmount; may mount again. */
  mount(): () => void;
  attach(surface: SurfaceHandle): () => void;
  /** Replace navigation/find inputs without detaching body geometry. */
  updateFind(find: FindSource<unknown>): void;
  /** Publish both products of one surface measurement; observers never recapture it. */
  viewport(
    viewport: Omit<Viewport, "identity" | "intent">,
    placement: Omit<Placement, "identity">,
    cause: "Observation" | "Geometry",
    pdf: PdfState | null,
  ): void;
  /** Genuine user input only. */
  input(direction: "forward" | "backward" | "none"): void;
  /** Geometry only: keeps reading mode and origin and never records progress. */
  reflow(input: {
    readonly placement: Placement | null;
    change(): void;
  }): Promise<NavOutcome>;
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
    placement: null,
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
    viewRestoration: null,
    savedSpotUnavailable: false,
    find: null,
  };
  const listeners = new Set<() => void>();
  let surface: SurfaceHandle | null = null;
  let loading: AbortController | null = null;
  let restore: {
    fresh: ReaderTarget | null;
    saved: Locator | null;
    inputCount: number;
  } | null = null;
  let freshUsed = false;
  let entryView = options.entry.view ?? null;
  let expectedGeneration: number | null = null;
  let input = {
    at: -Infinity,
    direction: "none" as "forward" | "backward" | "none",
  };
  // A load ignores earlier input; a title reread cannot erase a pending restore's veto.
  let inputCount = 0;
  let isAway = false;

  const navigate = (signal: AbortSignal | null = null) => {
    inputCount += 1;
    surface?.retireReflow();
    options.host?.onIntent?.({ kind: "Navigate", signal });
  };

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

  const navigator = createNavigator(() => {
    return surface?.identity === ready()?.doc.identity ? surface : null;
  }, {
    changed: () => set({ navigation: navigator.state() }),
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
      generation: () => { const identity = ready()?.doc.identity; return identity?.startsWith("g") ? Number(identity.slice(1)) : null; },
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

  function retireNavigationAttempt() {
    surface?.retireReflow();
    navigator.retireNavigationAttempt();
  }

  async function applySnapshot(snapshot: CursorSnapshot) {
    input = { at: -Infinity, direction: "none" };
    const doc = ready();
    if (!doc || snapshot.state === "Unresolved") return;
    const target: ReaderTarget | null =
      snapshot.state === "Positioned"
        ? targetOfLocator(doc.doc, snapshot.locator)
        : { kind: "edge", edge: "start" };
    if (target) await navigator.apply(target, "Restore");
  }

  async function load({ recoverPosition }: { recoverPosition: boolean }) {
    loading?.abort();
    const controller = new AbortController();
    loading = controller;
    const inputAtLoad = inputCount;
    const previous = ready()?.doc ?? null;
    if (state.document.status === "ready") {
      set({ document: { ...state.document, refreshing: true } });
    } else {
      set({ document: state.document.status === "failed"
        ? { ...state.document, retrying: true }
        : { status: "loading" } });
    }
    try {
      const [doc, initialView, fresh] = await Promise.all([
        options.source.load(controller.signal),
        previous ? null : sync?.start(controller.signal) ?? null,
        freshUsed ? null : options.entry.fresh,
      ]);
      if (controller.signal.aborted) return;
      if (expectedGeneration !== null && Number(doc.identity.slice(1)) < expectedGeneration) {
        throw new Error("reader response predates the observed publication");
      }
      freshUsed = true;
      const current = ready();
      const displayed = current?.doc.identity === doc.identity
        ? current.doc.kind === "text" && doc.kind === "text"
          ? { ...current.doc, title: doc.title, embeds: doc.embeds, xArticleContent: doc.xArticleContent, transcriptNavigation: doc.transcriptNavigation, transcriptCoverage: doc.transcriptCoverage, sections: doc.sections, toc: doc.toc }
          : { ...current.doc, title: doc.title }
        : doc;
      if (current?.doc.identity === doc.identity && (!recoverPosition || sync?.state().kind !== "LoadFailed")) {
        // Body identity fixes text coordinates; chapter navigation is replaceable.
        // Keep measured coordinates, held origin and unsaved progress intact.
        set({ document: { ...current, doc: displayed, structure: displayed.kind === "text" ? structureOf(displayed, null) : current.structure, refreshFailure: null } });
        return;
      }
      const view = previous
        ? await sync?.start(controller.signal) ?? null
        : initialView;
      if (controller.signal.aborted) return;
      if (previous) {
        if (previous.identity !== doc.identity) {
          retireNavigationAttempt();
          navigator.invalidateOrigin(doc.identity);
        }
        input = { at: -Infinity, direction: "none" };
      }
      restore = {
        fresh: fresh ?? null,
        saved: view && savedLocator(view),
        inputCount: inputAtLoad,
      };
      set({
        document: current?.doc.identity === doc.identity
          ? { ...current, doc: displayed, structure: displayed.kind === "text" ? structureOf(displayed, null) : current.structure, refreshFailure: null }
          : {
              status: "ready",
              doc,
              structure: structureOf(doc, doc.kind === "pdf" ? doc.pages : null),
              refreshing: true,
              refreshFailure: null,
            },
        viewport: null,
        placement: null,
        restored: false,
        viewRestoration: null,
        savedSpotUnavailable: false,
      });
      void restoreOnce();
    } catch (error) {
      if (!controller.signal.aborted) {
        set({ document: state.document.status === "ready"
          ? { ...state.document, refreshFailure: { error } }
          : { status: "failed", error, retrying: false } });
      }
    } finally {
      if (loading === controller) {
        loading = null;
        if (state.document.status === "ready")
          set({ document: { ...state.document, refreshing: false } });
      }
    }
  }

  /** Fresh target, visit view, saved cursor, cold target, then the start. */
  async function restoreOnce() {
    const doc = ready();
    const pending = restore;
    if (!doc || !pending || surface?.identity !== doc.doc.identity) return;
    restore = null;
    const visit = entryView;
    entryView = null;
    let outcome: "Restored" | "Absent" | "Failed" = "Absent";
    if (inputCount === pending.inputCount) {
      const { fresh, saved } = pending;
      if (saved?.kind === "pdf")
        surface.setZoom?.(saved.zoom === null ? null : clampZoom(saved.zoom));
      const savedTarget = saved && targetOfLocator(doc.doc, saved);
      if (fresh) await navigator.enter(fresh, saved);
      else if (visit?.identity === doc.doc.identity) {
        const restored = await navigator.restore(visit.placement, visit.navigation);
        outcome = restored.kind === "Arrived" || restored.kind === "Unchanged" ? "Restored" : "Failed";
      } else if (savedTarget) await navigator.apply(savedTarget, "Restore");
      else if (saved) set({ savedSpotUnavailable: true });
      else if (options.entry.cold) await navigator.apply(options.entry.cold, "Open");
    }
    // A title reread keeps this restoration; a different publication retires it.
    if (ready()?.doc.identity === doc.doc.identity) set({ restored: true, viewRestoration: { snapshot: visit, sourceIdentity: doc.doc.identity, outcome } });
  }

  return {
    navigation: options.host?.navigation ?? null,
    source: options.source,
    host: options.host,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    measurePassage(passage) {
      return passage.identity === ready()?.doc.identity &&
        surface?.identity === passage.identity
        ? surface.measurePassage(passage)
        : null;
    },
    measureBounds() {
      return surface && surface.identity === ready()?.doc.identity
        ? surface.measureBounds()
        : null;
    },
    captureSelection() {
      return surface && surface.identity === ready()?.doc.identity
        ? surface.captureSelection()
        : null;
    },
    focusSource() {
      if (surface && surface.identity === ready()?.doc.identity)
        surface.focusSource();
    },
    captureView() {
      const placement = state.placement;
      const identity = ready()?.doc.identity;
      const { mode, origin, originUnavailable } = navigator.state();
      return state.restored && placement && identity && placement.identity === identity
        ? { identity, placement, navigation: { mode, origin, originUnavailable } }
        : null;
    },
    async restoreView(snapshot, signal) {
      if (signal?.aborted) return { kind: "Cancelled" };
      const { mode, origin, originUnavailable } = navigator.state();
      input = { at: -Infinity, direction: "none" };
      const identity = ready()?.doc.identity;
      set({ viewRestoration: null });
      // A foreign placement fails at the surface without installing its mode or origin.
      const outcome = await navigator.restore(snapshot.placement, snapshot.identity === identity
        ? snapshot.navigation : { mode, origin, originUnavailable }, signal);
      if (identity && ready()?.doc.identity === identity && !signal?.aborted)
        set({ viewRestoration: { snapshot, sourceIdentity: identity, outcome: outcome.kind === "Arrived" || outcome.kind === "Unchanged" ? "Restored" : "Failed" } });
      return outcome;
    },
    restorePdfFind(target, signal) {
      if (signal.aborted || !surface || surface.identity !== ready()?.doc.identity || !surface.restorePdfFind) return Promise.resolve(false);
      return surface.restorePdfFind(target, signal);
    },
    locatePdfPassage(passage, signal) {
      if (signal.aborted || !surface || surface.identity !== ready()?.doc.identity || !surface.locatePdfPassage) return Promise.resolve(null);
      return surface.locatePdfPassage(passage, signal);
    },
    mount() {
      void load({ recoverPosition: false });
      return () => {
        loading?.abort();
        navigator.cancel();
        void sync?.flush(true);
        sync?.stop();
      };
    },
    attach(handle) {
      surface = handle;
      set({ find: handle.find });
      void restoreOnce();
      return () => {
        if (surface !== handle) return;
        surface = null;
        set({ find: null, placement: null });
      };
    },
    updateFind(find) {
      if (find.key === surface?.identity && state.find !== find) set({ find });
    },
    viewport(measured, placement, cause, pdf) {
      const doc = ready();
      if (!doc || surface?.identity !== doc.doc.identity) return;
      const { positioning, mode } = state.navigation;
      const reading =
        cause === "Observation" && performance.now() - input.at < READER_INTENT_MS && !positioning;
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
        placement: { ...placement, identity: doc.doc.identity },
        ...(pdf ? { pdf } : {}),
        ...(structure ? { document: { ...doc, structure } } : {}),
      });
      if (!reading || mode !== "Reading" || !state.restored || !sync || doc.refreshing) return;
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
      surface?.retireReflow();
      options.host?.onIntent?.({ kind: "Read" });
      input = { at: performance.now(), direction };
      inputCount += 1;
      isAway = false;
      navigator.cancel();
    },
    async reflow(change) {
      if (state.navigation.positioning) return navigator.reflow(change);
      const previous = input;
      const quiet: typeof input = { at: -Infinity, direction: "none" };
      input = quiet;
      const outcome = await navigator.reflow(change);
      // A no-op resize must not retire genuine inertia. Newer input or
      // authority wins; an uncaptured passage keeps the geometry fence.
      if (change.placement !== null && outcome.kind === "Unchanged" && input === quiet)
        input = previous;
      return outcome;
    },
    seek() {
      navigate();
      return navigator.seek();
    },
    away(flush) {
      isAway = true;
      if (flush) void sync?.flush(true);
    },
    inspect(input) {
      if (input.signal?.aborted) return Promise.resolve({ kind: "Cancelled" });
      navigate(input.signal ?? null);
      return navigator.inspect(input);
    },
    returnToSpot() {
      navigate();
      return navigator.returnToSpot();
    },
    continueHere() {
      navigate();
      const placement = navigator.continueHere();
      const adopted = placement && locator(placement);
      if (adopted && !ready()?.refreshing) sync?.report(adopted, { adoptUnresolved: true });
    },
    dismissNavigationFailure: (expected) => navigator.dismissNavigationFailure(expected),
    retireNavigationAttempt,
    resolveHandoff: async (choice) => sync?.resolve(choice),
    retrySave: () => sync?.retry(),
    retryLoad: () => { if (loading === null) void load({ recoverPosition: true }); },
    revalidate() {
      void sync?.revalidate().finally(() => {
        isAway = false;
      });
    },
    reload(generation) {
      if (generation !== undefined) {
        if (expectedGeneration !== null && generation <= expectedGeneration) return;
        expectedGeneration = generation;
      }
      void load({ recoverPosition: false });
    },
    async prepareProgressFence() {
      input = { at: -Infinity, direction: "none" };
      await sync?.prepareFence();
    },
    reconcileProgressFence: async () => sync?.reconcileFence(),
    install(snapshot) {
      sync?.install(snapshot);
      if (sync?.state().kind === "Ready") void applySnapshot(snapshot);
    },
    setZoom(zoom) {
      surface?.retireReflow();
      options.host?.onIntent?.({ kind: "Read" });
      inputCount += 1;
      navigator.cancel();
      surface?.setZoom?.(zoom === null ? null : clampZoom(zoom));
    },
    readFrom(point) {
      navigate();
      const doc = ready();
      if (!doc) return;
      // Not genuine input: the viewport, wherever it is, must not overwrite this point.
      input = { at: -Infinity, direction: "none" };
      navigator.readFrom();
      sync?.report(
        locatorAt(doc.doc, doc.structure, point, {
          terminal: false,
          zoom: null,
        }),
      );
    },
  };
}
