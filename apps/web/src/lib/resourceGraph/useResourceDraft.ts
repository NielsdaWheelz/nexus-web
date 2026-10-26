"use client";

// A visit owns one mutable draft cell. Acknowledgements update its subscribers
// even when the submitting surface has unmounted and another mount has returned.
import { useRef, useState, useSyncExternalStore } from "react";
import {
  definePaneVisitDataKey,
  usePaneVisitData,
  usePaneVisitIdentity,
  usePaneVisitWorkOwner,
  usePaneVisitWorkScope,
} from "@/lib/workspace/paneReturnMemento";
import type { WorkRisk } from "@/lib/unsavedWork";

export const resourceDraftOwnerId = (visitIdentity: string, name: string) =>
  JSON.stringify([visitIdentity, name]);

function draftCell<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    read: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(change: T | ((previous: T) => T)) {
      // justify-type-assertion: drafts are domain records, never callable values.
      value =
        typeof change === "function"
          ? (change as (previous: T) => T)(value)
          : change;
      for (const listener of listeners) listener();
    },
  };
}
export function useResourceDraft<T>(
  name: string, initial: () => T, risk?: (value: T) => WorkRisk, readCopyText?: (value: T) => string | null,
) {
  const owner = resourceDraftOwnerId(usePaneVisitIdentity(), name);
  const scope = usePaneVisitWorkScope();
  const holder = useRef<ReturnType<typeof draftCell<T>> | null>(null);
  const key = definePaneVisitDataKey<ReturnType<typeof draftCell<T>>>(name);
  const retained = usePaneVisitData(key, () => holder.current);
  const [opened, setOpened] = useState(() => ({
    owner,
    cell: retained ?? draftCell(initial()),
  }));
  let cell = opened.cell;
  if (opened.owner !== owner) {
    cell = retained ?? draftCell(initial());
    setOpened({ owner, cell });
  }
  holder.current = cell;
  usePaneVisitWorkOwner(risk ? {
    id: owner, scope, read: () => risk(cell.read()), subscribe: cell.subscribe,
    ...(readCopyText ? {readCopyText: () => readCopyText(cell.read())} : {}),
  } : null);
  const value = useSyncExternalStore(cell.subscribe, cell.read, cell.read);
  return {
    owner,
    value,
    read: cell.read,
    subscribe: cell.subscribe,
    set: cell.set,
  };
}
