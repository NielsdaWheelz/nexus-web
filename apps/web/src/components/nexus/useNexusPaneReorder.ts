"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { NexusPane } from "@/lib/nexus/model";
import { getInteractionOwner, useInteractionOwner, type Layer } from "@/lib/ui/overlay";
import { useLatestWorkspace, useSubscribeWorkspace } from "@/lib/workspace/store";

type Move = { readonly paneId: string; readonly paneIds: readonly string[] };

/** One temporary drag transaction. Workspace order stays in the store. */
export function useNexusPaneReorder(input: {
  readonly open: boolean;
  readonly eligible: boolean;
  readonly isMobile: boolean;
  readonly panes: readonly NexusPane[];
  readonly interactionLayer: RefObject<Layer | null>;
  readonly announce: (message: string) => void;
  readonly focus: (key: string | null) => void;
}) {
  const latestWorkspace = useLatestWorkspace();
  const subscribeWorkspace = useSubscribeWorkspace();
  const owner = useInteractionOwner();
  const latest = useRef(input);
  latest.current = input;
  const [draggingPaneId, setDraggingPaneId] = useState<string | null>(null);
  const drag = useRef<Move | null>(null);
  const [sensorEpoch, setSensorEpoch] = useState(0);

  function ownsInput() {
    const current = latest.current;
    const panes = latestWorkspace().state.panes;
    return current.open && current.eligible && current.interactionLayer.current !== null &&
      getInteractionOwner() === current.interactionLayer.current && panes.length === current.panes.length &&
      panes.every((pane, index) => pane.id === current.panes[index]!.id);
  }

  function valid(move: Move) {
    const ids = latestWorkspace().state.panes.map((pane) => pane.id);
    return ownsInput() && ids.length === move.paneIds.length &&
      ids.every((id, index) => id === move.paneIds[index]) && ids.includes(move.paneId);
  }

  function clear() {
    drag.current = null;
    setDraggingPaneId(null);
  }

  function cancel({ silent = false, restoreFocus = true }: { silent?: boolean; restoreFocus?: boolean } = {}): boolean {
    const source = drag.current?.paneId ?? null;
    const moving = drag.current !== null;
    clear();
    // Pending activation timers also belong to the retiring sensor, before drag start.
    setSensorEpoch((epoch) => epoch + 1);
    if (moving && !silent) {
      latest.current.announce("move cancelled");
      if (restoreFocus && latest.current.open && getInteractionOwner() === latest.current.interactionLayer.current) latest.current.focus(source !== null && latestWorkspace().state.panes.some((pane) => pane.id === source) ? `Pane:${source}` : null);
    }
    return moving;
  }

  function capture(paneId: string): Move | null {
    if (!ownsInput()) return null;
    const paneIds = latestWorkspace().state.panes.map((pane) => pane.id);
    return paneIds.includes(paneId) ? { paneId, paneIds } : null;
  }

  function commit(move: Move, position: number) {
    if (!valid(move) || !Number.isInteger(position) || position < 1 || position > move.paneIds.length) {
      cancel();
      return;
    }
    const source = latest.current.panes.find((pane) => pane.id === move.paneId);
    if (source === undefined) { cancel(); return; }
    const title = source.presentation.title;
    const same = move.paneIds.indexOf(move.paneId) === position - 1;
    const remaining = move.paneIds.filter((id) => id !== move.paneId);
    // Retire before the synchronous store notification, so our commit cannot cancel itself.
    clear();
    const moved = !same && latestWorkspace().movePane({ paneId: move.paneId, beforePaneId: remaining[position - 1] ?? null });
    latest.current.announce(same ? `already at position ${position} of ${move.paneIds.length}`
      : moved ? `moved ${title} to position ${position} of ${move.paneIds.length}` : "move cancelled");
    latest.current.focus(`Pane:${move.paneId}`);
  }

  const handlers = useRef({ cancel, valid });
  handlers.current = { cancel, valid };
  useLayoutEffect(() => subscribeWorkspace(() => {
    const move = drag.current;
    if (move !== null && !handlers.current.valid(move)) handlers.current.cancel({ silent: !latest.current.open || getInteractionOwner() !== latest.current.interactionLayer.current });
  }), [subscribeWorkspace]);
  const context = `${input.open}:${input.eligible}:${input.isMobile}`;
  const previousContext = useRef(context);
  useLayoutEffect(() => {
    if (previousContext.current !== context || getInteractionOwner() !== input.interactionLayer.current) {
      previousContext.current = context;
      handlers.current.cancel({ silent: !input.open || getInteractionOwner() !== input.interactionLayer.current });
    }
  }, [context, input.open, input.interactionLayer, owner]);
  useLayoutEffect(() => {
    const blur = () => handlers.current.cancel();
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("blur", blur);
      drag.current = null;
    };
  }, []);

  return {
    draggingPaneId,
    sensorEpoch,
    available: input.eligible,
    cancel,
    startDrag(paneId: string): boolean {
      const move = capture(paneId);
      if (move === null) return false;
      drag.current = move;
      setDraggingPaneId(paneId);
      latest.current.focus(`Pane:${paneId}`);
      return true;
    },
    endDrag(paneId: string, finalIndex: number) {
      const move = drag.current;
      if (move?.paneId !== paneId) { cancel(); return; }
      commit(move, finalIndex + 1);
    },
    cancelDrag() { cancel(); },
  };
}
