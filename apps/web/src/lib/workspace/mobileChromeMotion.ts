export const TOP_PINNED_SCROLL_PX = 8;
export const DIRECTION_REVERSAL_DEAD_ZONE_PX = 8;
export const COLLAPSE_TRAVEL_SCROLL_PX = 64;
export const SCROLL_IDLE_SETTLE_DELAY_MS = 120;
export const MIN_SCROLL_DELTA_PX = 1;

interface MobileChromeScrollSnapshot {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export type MobileChromeMotionDirection = "Up" | "Down";

export type MobileChromeMotionPhase =
  | { kind: "Visible" }
  | { kind: "Tracking"; direction: MobileChromeMotionDirection }
  | { kind: "Settling"; target: "Visible" | "Hidden" }
  | { kind: "Hidden" }
  | { kind: "Pinned" };

export interface MobileChromeMotionState {
  phase: MobileChromeMotionPhase;
  progress: number;
  lastScrollTop: number | null;
  direction: MobileChromeMotionDirection | null;
  reversalDistancePx: number;
}

export type MobileChromeMotionEvent =
  | { kind: "Start"; snapshot: MobileChromeScrollSnapshot }
  | { kind: "RefreshGeometry"; snapshot: MobileChromeScrollSnapshot }
  | { kind: "Scroll"; snapshot: MobileChromeScrollSnapshot }
  | { kind: "Settle" }
  | { kind: "FinishSettle" }
  | { kind: "Pin" }
  | { kind: "Unpin" };

export function initialMobileChromeMotionState(): MobileChromeMotionState {
  return {
    phase: { kind: "Visible" },
    progress: 0,
    lastScrollTop: null,
    direction: null,
    reversalDistancePx: 0,
  };
}

function clampedScrollTop(snapshot: MobileChromeScrollSnapshot): number {
  const maxScrollTop = Math.max(0, snapshot.scrollHeight - snapshot.clientHeight);
  return Math.min(Math.max(0, snapshot.scrollTop), maxScrollTop);
}

function phaseAtEndpoint(
  progress: number,
  direction: MobileChromeMotionDirection,
): MobileChromeMotionPhase {
  if (progress === 0) return { kind: "Visible" };
  if (progress === 1) return { kind: "Hidden" };
  return { kind: "Tracking", direction };
}

function stateForDirection(
  state: MobileChromeMotionState,
  direction: MobileChromeMotionDirection,
  progress: number,
  reversalDistancePx: number,
): MobileChromeMotionState {
  return {
    phase: phaseAtEndpoint(progress, direction),
    progress,
    lastScrollTop: state.lastScrollTop,
    direction,
    reversalDistancePx,
  };
}

function directionForDelta(delta: number): MobileChromeMotionDirection {
  return delta > 0 ? "Down" : "Up";
}

function progressAfterDistance(
  progress: number,
  direction: MobileChromeMotionDirection,
  distance: number,
): number {
  const delta = distance / COLLAPSE_TRAVEL_SCROLL_PX;
  return Math.min(1, Math.max(0, direction === "Down" ? progress + delta : progress - delta));
}

function scrollState(
  state: MobileChromeMotionState,
  snapshot: MobileChromeScrollSnapshot,
): MobileChromeMotionState {
  const scrollTop = clampedScrollTop(snapshot);
  if (scrollTop <= TOP_PINNED_SCROLL_PX) {
    return {
      phase: { kind: "Visible" },
      progress: 0,
      lastScrollTop: scrollTop,
      direction: null,
      reversalDistancePx: 0,
    };
  }

  if (state.lastScrollTop == null) {
    return {
      phase: { kind: "Visible" },
      progress: 0,
      lastScrollTop: scrollTop,
      direction: null,
      reversalDistancePx: 0,
    };
  }

  const delta = scrollTop - state.lastScrollTop;
  if (Math.abs(delta) < MIN_SCROLL_DELTA_PX) return state;

  const direction = directionForDelta(delta);
  const withScrollTop = { ...state, lastScrollTop: scrollTop };
  if (state.direction == null) {
    const reversalDistancePx = Math.abs(delta);
    return stateForDirection(
      withScrollTop,
      direction,
      progressAfterDistance(
        state.progress,
        direction,
        Math.max(0, reversalDistancePx - DIRECTION_REVERSAL_DEAD_ZONE_PX),
      ),
      reversalDistancePx,
    );
  }

  if (state.direction !== direction) {
    const reversalDistancePx = Math.abs(delta);
    const progress = progressAfterDistance(
      state.progress,
      direction,
      Math.max(0, reversalDistancePx - DIRECTION_REVERSAL_DEAD_ZONE_PX),
    );
    return {
      phase: phaseAtEndpoint(progress, direction),
      progress,
      lastScrollTop: scrollTop,
      direction,
      reversalDistancePx,
    };
  }

  const reversalDistancePx = state.reversalDistancePx + Math.abs(delta);
  const priorApplied = Math.max(0, state.reversalDistancePx - DIRECTION_REVERSAL_DEAD_ZONE_PX);
  const applied = Math.max(0, reversalDistancePx - DIRECTION_REVERSAL_DEAD_ZONE_PX) - priorApplied;
  return stateForDirection(
    withScrollTop,
    direction,
    progressAfterDistance(state.progress, direction, applied),
    reversalDistancePx,
  );
}

export function reduceMobileChromeMotion(
  state: MobileChromeMotionState,
  event: MobileChromeMotionEvent,
): MobileChromeMotionState {
  switch (event.kind) {
    case "Start": {
      const scrollTop = clampedScrollTop(event.snapshot);
      return {
        phase: { kind: "Visible" },
        progress: 0,
        lastScrollTop: scrollTop,
        direction: null,
        reversalDistancePx: 0,
      };
    }
    case "RefreshGeometry": {
      const scrollTop = clampedScrollTop(event.snapshot);
      if (
        event.snapshot.scrollHeight <= event.snapshot.clientHeight ||
        scrollTop <= TOP_PINNED_SCROLL_PX
      ) {
        return {
          phase:
            state.phase.kind === "Pinned"
              ? { kind: "Pinned" }
              : { kind: "Visible" },
          progress: 0,
          lastScrollTop: scrollTop,
          direction: null,
          reversalDistancePx: 0,
        };
      }
      return {
        ...state,
        lastScrollTop: scrollTop,
      };
    }
    case "Scroll":
      return scrollState(state, event.snapshot);
    case "Settle": {
      if (state.phase.kind === "Pinned" || state.progress === 0 || state.progress === 1) {
        return state;
      }
      return {
        ...state,
        phase: { kind: "Settling", target: state.progress < 0.5 ? "Visible" : "Hidden" },
      };
    }
    case "FinishSettle": {
      if (state.phase.kind !== "Settling") return state;
      const progress = state.phase.target === "Visible" ? 0 : 1;
      return {
        ...state,
        phase: progress === 0 ? { kind: "Visible" } : { kind: "Hidden" },
        progress,
      };
    }
    case "Pin":
      return {
        ...state,
        phase: { kind: "Pinned" },
        progress: 0,
        direction: null,
        reversalDistancePx: 0,
      };
    case "Unpin":
      return {
        ...state,
        phase: { kind: "Visible" },
        progress: 0,
        direction: null,
        reversalDistancePx: 0,
      };
  }
}

export function mobileChromePresentationProgress(state: MobileChromeMotionState): number {
  if (state.phase.kind === "Settling") {
    return state.phase.target === "Visible" ? 0 : 1;
  }
  return state.progress;
}
