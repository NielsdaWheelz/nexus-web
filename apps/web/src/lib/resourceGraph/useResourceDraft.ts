"use client";

// A visit owns one mutable draft cell. Acknowledgements update its subscribers
// even when the submitting surface has unmounted and another mount has returned.
import { useRef, useState, useSyncExternalStore } from "react";
import {
  definePaneVisitDataKey,
  usePaneVisitData,
  usePaneVisitIdentity,
} from "@/lib/workspace/paneReturnMemento";
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
export function useResourceDraft<T>(name: string, initial: () => T) {
  const owner = JSON.stringify([usePaneVisitIdentity(), name]);
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
  const value = useSyncExternalStore(cell.subscribe, cell.read, cell.read);
  return {
    owner,
    value,
    read: cell.read,
    set: cell.set,
  };
}
