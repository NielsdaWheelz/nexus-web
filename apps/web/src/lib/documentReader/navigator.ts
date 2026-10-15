// Reading mode: while reading, the viewport feeds the cursor; a deliberate
// jump enters exploring and holds the departure for return. Later jumps keep
// the first origin. A failed jump rolls back to its departure. Positioning
// itself fences progress.
import type { Locator, Placement, ReaderTarget } from "./model";

export type NavFailure =
  | "CaptureUnavailable"
  | "TargetUnavailable"
  | "SourceChanged"
  | "PositioningFailed";
export type NavOutcome =
  | { readonly kind: "Arrived" | "Unchanged" | "Cancelled" }
  | { readonly kind: "Unavailable"; readonly reason: NavFailure };
export interface NavState {
  readonly mode: "Reading" | "Exploring";
  readonly origin:
    | { readonly kind: "placement"; readonly placement: Placement }
    | { readonly kind: "saved"; readonly locator: Locator }
    | null;
  readonly originUnavailable: boolean;
  readonly positioning: boolean;
  readonly failure: NavFailure | null;
}
type To = ReaderTarget | Placement;
export interface Positioner {
  capture(): Placement | null;
  position(to: To, signal: AbortSignal): Promise<NavOutcome>;
}
export interface Navigator {
  state(): NavState;
  inspect(input: {
    readonly target: ReaderTarget;
    readonly signal?: AbortSignal;
  }): Promise<NavOutcome>;
  /** A fresh entry (deep link): exploring from the start, origin = the saved cursor. */
  enter(target: ReaderTarget, saved: Locator | null): Promise<NavOutcome>;
  seek(): { settle(moved: boolean): void; cancel(): void } | null;
  returnToSpot(): Promise<NavOutcome>;
  /** The placement to adopt as the cursor, or null when there is none. */
  continueHere(): Placement | null;
  /** Restore, remote, reset: fenced, ends Reading. */
  apply(to: To): Promise<NavOutcome>;
  /** Preserve the last explicit target, or measured passage, through a layout change. */
  reflow(input: {
    readonly placement: Placement | null;
    change(): void;
  }): Promise<NavOutcome>;
  cancel(): void;
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
  readonly previous: NavState;
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
  const fail = (failure: NavFailure): NavOutcome => {
    publish({ ...state, failure });
    return { kind: "Unavailable", reason: failure };
  };

  function begin(
    kind: Request["kind"],
    saved: Locator | null = null,
  ): Request | null {
    if (kind !== "reflow") reflowTarget = null;
    // A superseded request keeps its departure: the viewport may be mid-move.
    const departure =
      kind === "entry" || kind === "apply" || kind === "reflow"
        ? null
        : (surface()?.capture() ?? request?.departure ?? null);
    if (kind === "inspect" && departure === null) return null;
    if (kind === "inspect" && state.mode === "Reading" && !state.positioning) {
      hooks.beforeExplore();
    }
    const previous = request?.previous ?? state;
    request?.controller.abort();
    const next: Request = {
      kind,
      controller: new AbortController(),
      departure,
      previous,
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
          : outcome.kind === "Unchanged" && req.kind !== "entry"
            ? { ...req.previous, positioning: false }
            : { ...state, positioning: false },
      );
    } else if (outcome.kind === "Cancelled") {
      publish({ ...state, positioning: false });
    } else {
      publish({
        ...(restored ? req.previous : state),
        positioning: false,
        failure,
        originUnavailable:
          state.originUnavailable ||
          (req.kind === "return" && failure === "TargetUnavailable"),
      });
    }
    return outcome;
  }

  async function run(req: Request | null, to: To): Promise<NavOutcome> {
    if (req === null) return fail("CaptureUnavailable");
    const handle = surface();
    const outcome: NavOutcome = handle
      ? await handle.position(to, req.controller.signal)
      : { kind: "Unavailable", reason: "PositioningFailed" };
    if (
      request === req && !req.controller.signal.aborted &&
      req.kind !== "reflow" &&
      (outcome.kind === "Arrived" || outcome.kind === "Unchanged")
    ) {
      // PDF commands can focus or depend on mutable viewer state;
      // reflow uses their measured placement.
      reflowTarget =
        "kind" in to && (to.kind === "pdfMatch" || to.kind === "pdfDest")
          ? null
          : to;
    }
    return settle(req, req.controller.signal.aborted ? { kind: "Cancelled" } : outcome);
  }

  return {
    state: () => state,
    async inspect({ target, signal }) {
      if (signal?.aborted) return { kind: "Cancelled" };
      const req = begin("inspect");
      if (req === null) return fail("CaptureUnavailable");
      // The signal owns this request, never whichever request is current later.
      const abort = () => req.controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      try {
        return await run(req, target);
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
    enter: (target, saved) => run(begin("entry", saved), target),
    apply: (to) => run(begin("apply"), to),
    reflow({ placement, change }) {
      const to = reflowTarget ?? placement;
      if (state.positioning || to === null) {
        change();
        return Promise.resolve({ kind: "Unchanged" });
      }
      const req = begin("reflow");
      change();
      return run(req, to);
    },
    seek() {
      const req = begin("inspect");
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
      const { origin } = state;
      if (state.mode !== "Exploring" || origin === null)
        return { kind: "Unchanged" };
      const to =
        origin.kind === "placement"
          ? origin.placement
          : hooks.locate(origin.locator);
      if (state.originUnavailable || to === null) {
        publish({ ...state, originUnavailable: true });
        return { kind: "Unavailable", reason: "SourceChanged" };
      }
      return run(begin("return"), to);
    },
    continueHere() {
      reflowTarget = null;
      request?.controller.abort();
      request = null;
      if (state.mode === "Reading") {
        if (state.positioning) publish(READING);
        return null;
      }
      const placement = surface()?.capture() ?? null;
      if (placement === null) {
        publish({ ...state, positioning: false, failure: "CaptureUnavailable" });
        return null;
      }
      publish(READING);
      return placement;
    },
    cancel() {
      reflowTarget = null;
      if (request === null) return;
      request.controller.abort();
      request = null;
      publish({ ...state, positioning: false });
    },
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
}
