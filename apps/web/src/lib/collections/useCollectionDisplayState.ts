"use client";

import { useMemo } from "react";
import {
  collectionDisplayStateFromParams,
  collectionDisplayStateToParams,
  type CollectionDisplayState,
} from "@/lib/collections/collectionViewState";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";

export function useCollectionDisplayState(basePath: string): {
  displayState: CollectionDisplayState;
  setDisplayState: (next: CollectionDisplayState) => void;
} {
  const codec = useMemo(
    () => ({
      basePath,
      decode: collectionDisplayStateFromParams,
      encode: (next: CollectionDisplayState, currentParams: URLSearchParams) =>
        collectionDisplayStateToParams(next, new URLSearchParams(currentParams)),
      replaceOptions: { viewTransition: { kind: "collection-reflow" } as const },
    }),
    [basePath],
  );
  const { state, setState } = usePaneUrlState(codec);
  return { displayState: state, setDisplayState: setState };
}
