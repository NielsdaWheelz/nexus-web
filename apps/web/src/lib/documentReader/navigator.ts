// Reading mode: while reading, the viewport feeds the cursor; a deliberate
// jump enters exploring and holds the departure for return. Later jumps keep
// the first origin. A failed jump rolls back to its departure. Positioning
// itself fences progress. Failure occurrences stay live, outside stable
// navigation snapshots; only their exact object can be acknowledged. Inspection
// admits its departure before resolving, and only its current request may settle.
import type { Locator, Placement, ReaderTarget } from "./model";
import { assertNever } from "@/lib/assertNever";

export type NavFailure =
  | "CaptureUnavailable"
  | "TargetUnavailable"
  | "SourceChanged"
  | "PositioningFailed";
export type NavOutcome =
  | { readonly kind: "Arrived" | "Unchanged" | "Cancelled" }
  | { readonly kind: "Unavailable"; readonly reason: NavFailure };
export type NavigationFailure = {
  readonly operation: "Open" | "Restore" | "Return" | "Reflow" | "Continue";
  readonly reason: NavFailure;
};
export interface NavState {
  readonly mode: "Reading" | "Exploring";
  readonly origin:
    | { readonly kind: "placement"; readonly placement: Placement }
    | { readonly kind: "saved"; readonly locator: Locator }
    | null;
  readonly originUnavailable: boolean;
  readonly positioning: boolean;
  readonly failure: NavigationFailure | null;
}
export type NavSnapshot = Pick<NavState, "mode" | "origin" | "originUnavailable">;
type To = ReaderTarget | Placement;
export interface Positioner {
  capture(): Placement | null;
  /** Position cancellation ends with movement; inspection paint retains its host's lifetime. */
  position(to: To, signal: AbortSignal, inspectionSignal: AbortSignal | null): Promise<NavOutcome>;
}
export interface Navigator {
  state(): NavState;
  inspect(input: {
    readonly target: ReaderTarget | ((signal: AbortSignal) => ReaderTarget | null | Promise<ReaderTarget | null>);
    readonly signal?: AbortSignal;
  }): Promise<NavOutcome>;
  /** A fresh entry (deep link): exploring from the start, origin = the saved cursor. */
  enter(target: ReaderTarget, saved: Locator | null): Promise<NavOutcome>;
  restore(placement: Placement, state: NavSnapshot, signal?: AbortSignal): Promise<NavOutcome>;
  seek(): { settle(moved: boolean): void; cancel(): void } | null;
  returnToSpot(): Promise<NavOutcome>;
  /** The placement to adopt as the cursor, or null when there is none. */
  continueHere(): Placement | null;
  /** Adopt an explicitly supplied reading point; its caller owns the cursor. */
  readFrom(): void;
  /** Restore, remote, reset: fenced, ends Reading. */
  apply(to: To, purpose: "Open" | "Restore"): Promise<NavOutcome>;
  /** Preserve the last explicit target, or measured passage, through a layout change. */
  reflow(input: {
    readonly placement: Placement | null;
    change(): void;
  }): Promise<NavOutcome>;
  cancel(): void;
  dismissNavigationFailure(expected: NavigationFailure): void;
  retireNavigationAttempt(): void;
  invalidateOrigin(identity: string): void;
}

const READING: NavState = {
  mode: "Reading",
  origin: null,
  originUnavailable: false,
  positioning: false,
  failure: null,
};

interface Request {
  readonly kind: "inspect" | "entry" | "return" | "apply" | "reflow";
  readonly controller: AbortController;
  readonly departure: Placement | null;
  readonly previous: NavSnapshot;
  readonly operation: NavigationFailure["operation"];
  inspectionSignal: AbortSignal | null;
}

export function createNavigator(
  surface: () => Positioner | null,
  hooks: {
    changed(): void;
    /** Leaving Reading: flush any unsaved reading movement first. */
    beforeExplore(): void;
    locate(locator: Locator): ReaderTarget | null;
  },
): Navigator {
  let state = READING;
  let request: Request | null = null;
  // A completed jump can be clamped before late layout expands. Keep its
  // intent until a newer decision; measuring the reading line cannot replace it.
  let reflowTarget: To | null = null;
  const publish = (next: NavState) => {
    state = next;
    hooks.changed();
  };
  const fail = (operation: NavigationFailure["operation"], reason: NavFailure): NavOutcome => {
    publish({ ...state, positioning: false, failure: { operation, reason } });
    return { kind: "Unavailable", reason };
  };

  function begin(
    kind: Request["kind"],
    operation: NavigationFailure["operation"],
    saved: Locator | null = null,
  ): Request | null {
    if (kind !== "reflow") reflowTarget = null;
    // A superseded request keeps its departure: the viewport may be mid-move.
    const departure =
      kind === "entry" || kind === "apply" || kind === "reflow"
        ? null
        : (surface()?.capture() ?? request?.departure ?? null);
    const previous = request?.previous ?? {
      mode: state.mode, origin: state.origin, originUnavailable: state.originUnavailable,
    };
    request?.controller.abort();
    request = null;
    // Admission retires the older attempt even when departure capture fails.
    if (kind === "inspect" && departure === null) {
      fail(operation, "CaptureUnavailable");
      return null;
    }
    if (kind === "inspect" && state.mode === "Reading" && !state.positioning) {
      hooks.beforeExplore();
    }
    const next: Request = {
      kind,
      controller: new AbortController(),
      departure,
      previous,
      operation,
      inspectionSignal: null,
    };
    request = next;
    const origin: NavState["origin"] =
      kind === "entry"
        ? saved && { kind: "saved", locator: saved }
        : state.mode === "Exploring" || kind !== "inspect"
          ? state.origin
          : departure && { kind: "placement", placement: departure };
    publish({
      ...state,
      mode: kind === "inspect" || kind === "entry" ? "Exploring" : state.mode,
      origin,
      originUnavailable: kind === "entry" ? false : state.originUnavailable,
      positioning: true,
      failure: kind === "reflow" ? state.failure : null,
    });
    return next;
  }

  async function settle(
    req: Request,
    outcome: NavOutcome,
  ): Promise<NavOutcome> {
    if (request !== req) return { kind: "Cancelled" };
    let restored = false;
    const failure = outcome.kind === "Unavailable" ? outcome.reason : null;
    if (failure && req.departure && failure !== "SourceChanged") {
      const back = await surface()?.position(
        req.departure,
        req.controller.signal,
        null,
      );
      if (request !== req) return { kind: "Cancelled" };
      if (req.controller.signal.aborted) outcome = { kind: "Cancelled" };
      restored = back?.kind === "Arrived" || back?.kind === "Unchanged";
    }
    request = null;
    if (outcome.kind === "Arrived" || outcome.kind === "Unchanged") {
      publish(
        req.kind === "return" || req.kind === "apply"
          ? READING
          : outcome.kind === "Unchanged" && req.kind !== "entry" && req.kind !== "inspect"
            ? { ...req.previous, positioning: false, failure: state.failure }
            : { ...state, positioning: false },
      );
    } else if (outcome.kind === "Cancelled") {
      publish({ ...state, positioning: false });
    } else if (outcome.kind === "Unavailable") {
      publish({
        ...(restored ? req.previous : state),
        positioning: false,
        failure: { operation: req.operation, reason: outcome.reason },
        originUnavailable:
          state.originUnavailable ||
          (req.kind === "return" && failure === "TargetUnavailable"),
      });
    } else {
      assertNever(outcome.kind);
    }
    return outcome;
  }

  async function run(req: Request | null, target: To | ((signal: AbortSignal) => ReaderTarget | null | Promise<ReaderTarget | null>)): Promise<NavOutcome> {
    if (req === null) return { kind: "Unavailable", reason: "CaptureUnavailable" };
    try {
      const to = typeof target === "function" ? await target(req.controller.signal) : target;
      if (request !== req || req.controller.signal.aborted) return { kind: "Cancelled" };
      const handle = surface();
      const outcome: NavOutcome = to === null
        ? { kind: "Unavailable", reason: "TargetUnavailable" }
        : handle
          ? await handle.position(to, req.controller.signal, req.inspectionSignal)
          : { kind: "Unavailable", reason: "PositioningFailed" };
      if (
        to !== null && request === req && !req.controller.signal.aborted &&
        (req.kind !== "reflow" || req.operation === "Restore") &&
        (outcome.kind === "Arrived" || outcome.kind === "Unchanged")
      ) {
        // Keep the completed intent through late layout. PDF commands may
        // focus or depend on mutable viewer state; retain their placement.
        reflowTarget =
          "kind" in to && (to.kind === "pdfMatch" || to.kind === "pdf" || to.kind === "pdf_find")
            ? handle?.capture() ?? null
            : to;
      }
      return await settle(req, req.controller.signal.aborted ? { kind: "Cancelled" } : outcome);
    } catch (error) {
      if (req.controller.signal.aborted) return { kind: "Cancelled" };
      if (request === req) navigatorCancel();
      throw error;
    }
  }

  return {
    state: () => state,
    async inspect({ target, signal }) {
      if (signal?.aborted) return { kind: "Cancelled" };
      const req = begin("inspect", "Open");
      if (req === null) return { kind: "Unavailable", reason: "CaptureUnavailable" };
      req.inspectionSignal = signal ?? null;
      // The signal owns this request, never whichever request is current later.
      const abort = () => {
        req.controller.abort();
        if (request === req) navigatorCancel();
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      try {
        return await run(req, target);
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
    enter: (target, saved) => run(begin("entry", "Open", saved), target),
    async restore(placement, previous, signal) {
      if (signal?.aborted) return { kind: "Cancelled" };
      navigatorCancel();
      publish({ mode: previous.mode, origin: previous.origin, originUnavailable: previous.originUnavailable, positioning: false, failure: null });
      const req = begin("reflow", "Restore");
      if (!req) return { kind: "Unavailable", reason: "PositioningFailed" };
      const abort = () => {
        req.controller.abort();
        if (request === req) navigatorCancel();
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      try { return await run(req, placement); }
      finally { signal?.removeEventListener("abort", abort); }
    },
    apply: (to, purpose) => run(begin("apply", purpose), to),
    reflow({ placement, change }) {
      const to = reflowTarget ?? placement;
      if (state.positioning || to === null) {
        change();
        return Promise.resolve({ kind: "Unchanged" });
      }
      const req = begin("reflow", "Reflow");
      change();
      return run(req, to);
    },
    seek() {
      const req = begin("inspect", "Open");
      if (req === null) return null;
      return {
        settle: (moved) =>
          void settle(req, { kind: moved ? "Arrived" : "Unchanged" }),
        cancel() {
          req.controller.abort();
          void settle(req, { kind: "Cancelled" });
        },
      };
    },
    async returnToSpot() {
      retireNavigationAttempt();
      const { origin } = state;
      if (state.mode !== "Exploring" || origin === null)
        return { kind: "Unchanged" };
      const to =
        origin.kind === "placement"
          ? origin.placement
          : hooks.locate(origin.locator);
      if (state.originUnavailable || to === null) {
        publish({ ...state, originUnavailable: true });
        return fail("Return", "SourceChanged");
      }
      return run(begin("return", "Return"), to);
    },
    continueHere() {
      reflowTarget = null;
      request?.controller.abort();
      request = null;
      const placement = surface()?.capture() ?? null;
      if (placement === null) {
        fail("Continue", "CaptureUnavailable");
        return null;
      }
      publish(READING);
      return placement;
    },
    readFrom() {
      navigatorCancel();
      publish(READING);
    },
    cancel: navigatorCancel,
    dismissNavigationFailure(expected) {
      if (state.failure === expected) publish({ ...state, failure: null });
    },
    retireNavigationAttempt,
    invalidateOrigin(identity) {
      const { origin } = state;
      if (
        origin?.kind === "placement" &&
        origin.placement.identity !== identity
      ) {
        publish({ ...state, originUnavailable: true });
      }
    },
  };

  function navigatorCancel() {
    reflowTarget = null;
    if (request === null) return;
    request.controller.abort();
    request = null;
    publish({ ...state, positioning: false });
  }

  function retireNavigationAttempt() {
    navigatorCancel();
    if (state.failure !== null) publish({ ...state, failure: null });
  }
}
