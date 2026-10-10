"use client";

import { RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { isAbortError } from "@/lib/errors";
import {
  PANE_COMMAND_RESOLVING_REASON,
  type PaneRefresh,
  type PaneRefreshProgress,
  type PaneRefreshResult,
} from "@/lib/panes/paneChrome";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import styles from "./PaneShell.module.css";

const ARM_PX = 72;
const MAX_PX = 96;
const RESISTANCE = 0.45;
const SETTLED_MS = 900;

type State =
  | { readonly kind: "Idle" }
  | { readonly kind: "Pulling" | "Armed"; readonly offsetPx: number }
  | { readonly kind: "Refreshing"; readonly progress: PaneRefreshProgress }
  | { readonly kind: "Settled"; readonly result: PaneRefreshResult };

function feedback(state: State): string | null {
  switch (state.kind) {
    case "Idle":
      return null;
    case "Pulling":
      return "Pull to refresh";
    case "Armed":
      return "Release to refresh";
    case "Refreshing":
      return state.progress.kind === "Determinate"
        ? `Refreshing ${state.progress.finishedCount} of ${state.progress.requestedCount}`
        : "Refreshing";
    case "Settled":
      return state.result.announcement;
  }
}

/**
 * The pane's one refresh operation, shared by the More command, the mobile
 * pull gesture on the scrollport and the indicator. An execution belongs to
 * the fence (route and source) that started it: a new fence aborts it, so its
 * result never lands on another route or source.
 */
export function usePaneRefresh(input: {
  readonly refresh: PaneRefresh | undefined;
  readonly routeKey: string;
  /** The pull gesture applies: an active mobile standard pane that can refresh. */
  readonly pull: boolean;
  readonly scrollportRef: RefObject<HTMLDivElement | null>;
}): {
  readonly command: ActionDescriptor | null;
  readonly indicator: ReactNode;
  readonly announcement: ReactNode;
} {
  const { refresh, pull, scrollportRef } = input;
  const fence = `${input.routeKey}|${refresh?.kind === "Refreshable" ? refresh.sourceKey : ""}`;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const [state, setStateValue] = useState<State>({ kind: "Idle" });
  const stateRef = useRef(state);
  const setState = useCallback((next: State) => {
    stateRef.current = next;
    setStateValue(next);
  }, []);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const execution = useRef<AbortController | null>(null);
  const settledTimer = useRef(0);

  const start = useCallback(() => {
    const current = refreshRef.current;
    if (current?.kind !== "Refreshable" || execution.current) return;
    const controller = new AbortController();
    const mine = () => execution.current === controller;
    execution.current = controller;
    window.clearTimeout(settledTimer.current);
    setAnnouncement(null);
    setState({ kind: "Refreshing", progress: { kind: "Indeterminate" } });
    current
      .execute({
        signal: controller.signal,
        reportProgress: (progress) => {
          if (mine()) setState({ kind: "Refreshing", progress });
        },
      })
      .then(
        (result) => {
          if (!mine()) return;
          execution.current = null;
          setAnnouncement(result.announcement);
          setState({ kind: "Settled", result });
          settledTimer.current = window.setTimeout(
            () => setState({ kind: "Idle" }),
            SETTLED_MS,
          );
        },
        (error: unknown) => {
          if (!mine()) return;
          execution.current = null;
          setState({ kind: "Idle" });
          if (!isAbortError(error)) setDefect({ error });
        },
      );
  }, [setState]);

  // a new route or source aborts the running refresh and drops what it showed.
  useLayoutEffect(() => {
    const abort = () => {
      window.clearTimeout(settledTimer.current);
      execution.current?.abort(
        new DOMException("Pane refresh target changed.", "AbortError"),
      );
      execution.current = null;
    };
    abort();
    setAnnouncement(null);
    setState({ kind: "Idle" });
    return abort;
  }, [fence, setState]);

  useEffect(() => {
    const port = scrollportRef.current;
    let touch: { id: number; x: number; y: number } | null = null;
    const cancel = () => {
      touch = null;
      const { kind } = stateRef.current;
      if (kind === "Pulling" || kind === "Armed") setState({ kind: "Idle" });
    };
    if (!pull || !port) return cancel();
    const onStart = (event: TouchEvent) => {
      const first = event.touches[0];
      if (
        !first ||
        event.touches.length !== 1 ||
        port.scrollTop !== 0 ||
        execution.current
      )
        return cancel();
      touch = { id: first.identifier, x: first.clientX, y: first.clientY };
    };
    const onMove = (event: TouchEvent) => {
      if (!touch) return;
      const { id, x, y } = touch;
      const now = [...event.touches].find((t) => t.identifier === id);
      const dy = now ? now.clientY - y : 0;
      if (
        !now ||
        event.touches.length !== 1 ||
        port.scrollTop !== 0 ||
        dy <= 0 ||
        Math.abs(now.clientX - x) >= dy
      )
        return cancel();
      event.preventDefault();
      const offsetPx = Math.min(MAX_PX, dy * RESISTANCE);
      setState({ kind: offsetPx >= ARM_PX ? "Armed" : "Pulling", offsetPx });
    };
    const onEnd = () => {
      if (!touch) return;
      touch = null;
      if (stateRef.current.kind === "Armed") start();
      else cancel();
    };
    port.addEventListener("touchstart", onStart, { passive: true });
    port.addEventListener("touchmove", onMove, { passive: false });
    port.addEventListener("touchend", onEnd, { passive: true });
    port.addEventListener("touchcancel", cancel, { passive: true });
    return () => {
      port.removeEventListener("touchstart", onStart);
      port.removeEventListener("touchmove", onMove);
      port.removeEventListener("touchend", onEnd);
      port.removeEventListener("touchcancel", cancel);
      cancel();
    };
  }, [pull, scrollportRef, setState, start]);

  if (defect) throw defect.error;

  const refreshing = state.kind === "Refreshing" ? state : null;
  const determinate =
    refreshing?.progress.kind === "Determinate" ? refreshing.progress : null;
  const offsetPx =
    state.kind === "Pulling" || state.kind === "Armed"
      ? state.offsetPx
      : state.kind === "Idle"
        ? 0
        : ARM_PX;
  const text = feedback(state);
  return {
    command: refresh
      ? {
          kind: "command",
          id: "Pane.Refresh",
          label: "Refresh",
          icon: <RefreshCw size={16} aria-hidden="true" />,
          disabled: refresh.kind === "Resolving" || refreshing !== null,
          disabledReason:
            refresh.kind === "Resolving"
              ? PANE_COMMAND_RESOLVING_REASON
              : undefined,
          onSelect: start,
        }
      : null,
    indicator: (
      <div
        className={styles.refreshIndicator}
        data-refresh-state={state.kind}
        style={{ "--pane-refresh-offset": `${offsetPx}px` } as CSSProperties}
        role={refreshing ? "progressbar" : undefined}
        aria-label={refreshing ? (text ?? undefined) : undefined}
        aria-hidden={refreshing ? undefined : "true"}
        aria-valuemin={determinate ? 0 : undefined}
        aria-valuemax={determinate?.requestedCount}
        aria-valuenow={determinate?.finishedCount}
      >
        <span className={styles.refreshIndicatorContent}>
          <RefreshCw
            className={styles.refreshIndicatorIcon}
            size={14}
            aria-hidden="true"
          />
          {text}
        </span>
      </div>
    ),
    announcement: (
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    ),
  };
}
