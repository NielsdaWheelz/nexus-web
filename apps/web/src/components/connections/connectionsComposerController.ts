"use client";

import { useRef } from "react";
import type { EdgeKind } from "@/lib/resourceGraph/connections";
import type { ResourceRef } from "@/lib/resourceGraph/resourceRef";
import { formatResourceRef } from "@/lib/resourceGraph/resourceRef";
import type { ResourceTarget } from "@/lib/resources/resourceTargets";

export interface ConnectionsComposerDraft {
  open: boolean;
  query: string;
  kind: EdgeKind;
  selected: ResourceTarget | null;
  activeKey: string | null;
}

export interface ConnectionsComposerController {
  getSnapshot(): ConnectionsComposerDraft;
  subscribe(listener: () => void): () => void;
  update(patch: Partial<ConnectionsComposerDraft>): void;
}

const INITIAL_DRAFT: ConnectionsComposerDraft = {
  open: false,
  query: "",
  kind: "context",
  selected: null,
  activeKey: null,
};

function createConnectionsComposerController(): ConnectionsComposerController {
  let snapshot = INITIAL_DRAFT;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(patch) {
      const next = { ...snapshot, ...patch };
      if (
        next.open === snapshot.open &&
        next.query === snapshot.query &&
        next.kind === snapshot.kind &&
        next.selected === snapshot.selected &&
        next.activeKey === snapshot.activeKey
      ) {
        return;
      }
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}

/**
 * The primary resource pane owns this subject-keyed controller. Secondary tab
 * bodies may unmount freely without discarding an unfinished connection draft.
 */
export function useConnectionsComposerController(
  resourceRef: ResourceRef,
): ConnectionsComposerController {
  const subjectKey = formatResourceRef(resourceRef);
  const boxRef = useRef<{
    subjectKey: string;
    controller: ConnectionsComposerController;
  } | null>(null);
  if (boxRef.current?.subjectKey !== subjectKey) {
    boxRef.current = {
      subjectKey,
      controller: createConnectionsComposerController(),
    };
  }
  return boxRef.current.controller;
}
