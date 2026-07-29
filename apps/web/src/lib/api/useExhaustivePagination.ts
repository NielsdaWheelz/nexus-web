"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ApiError,
  isApiError,
} from "@/lib/api/client";
import type {
  CollectionCursor,
  CollectionPage,
  CollectionRevision,
} from "@/lib/api/collectionPage";
import type { Presence } from "@/lib/api/presence";
import { requestWithRetry } from "@/lib/api/retryPolicy";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";

export type ExhaustionState =
  | { readonly kind: "Idle" }
  | { readonly kind: "Draining"; readonly loadedCount: number }
  | { readonly kind: "Complete"; readonly itemCount: number }
  | {
      readonly kind: "ResumeFailed";
      readonly error: ApiError;
      readonly retry: () => void;
    }
  | {
      readonly kind: "RefreshRequired";
      readonly reason: "CollectionChanged" | "InvalidCursor";
      readonly error: ApiError;
      readonly refresh: () => void;
    };

export interface ExhaustivePaginationArgs<T> {
  readonly active: boolean;
  readonly chainKey: string;
  readonly cursor: Presence<CollectionCursor>;
  readonly collectionRevision: CollectionRevision;
  readonly itemCount: number;
  readonly loadPage: (
    cursor: CollectionCursor,
    revision: CollectionRevision,
    signal: AbortSignal,
  ) => Promise<CollectionPage<T>>;
  /** Commit, dedupe, and return the total committed row count. */
  readonly commitPage: (page: CollectionPage<T>) => number;
  readonly refresh: () => void;
}

interface Driver {
  readonly generation: number;
  readonly collectionRevision: CollectionRevision;
  readonly visitedCursors: Set<CollectionCursor>;
  nextCursor: Presence<CollectionCursor>;
  itemCount: number;
  inFlight: boolean;
  controller: AbortController | null;
}

function isVisible(): boolean {
  return (
    typeof document === "undefined" ||
    document.visibilityState !== "hidden"
  );
}

function collectionDefect(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Unexpected collection continuation failure");
}

export function useExhaustivePagination<T>({
  active,
  chainKey,
  cursor,
  collectionRevision,
  itemCount,
  loadPage,
  commitPage,
  refresh,
}: ExhaustivePaginationArgs<T>): ExhaustionState {
  const [state, setState] = useState<ExhaustionState>({ kind: "Idle" });
  const [defect, setDefect] = useState<Error | null>(null);
  const generationRef = useRef(0);
  const driverRef = useRef<Driver | null>(null);
  const activeRef = useRef(active);
  const loadPageRef = useRef(loadPage);
  const commitPageRef = useRef(commitPage);
  const refreshRef = useRef(refresh);
  const seedRef = useRef({ cursor, collectionRevision, itemCount });
  activeRef.current = active;
  loadPageRef.current = loadPage;
  commitPageRef.current = commitPage;
  refreshRef.current = refresh;
  seedRef.current = { cursor, collectionRevision, itemCount };
  const handleUnauthenticatedApiError = useUnauthenticatedApiHandler();
  const handleUnauthenticatedRef = useRef(handleUnauthenticatedApiError);
  handleUnauthenticatedRef.current = handleUnauthenticatedApiError;
  const startRef = useRef<() => void>(() => {});

  const start = useCallback(() => {
    const driver = driverRef.current;
    if (
      driver === null ||
      driver.inFlight ||
      !activeRef.current ||
      !isVisible()
    ) {
      return;
    }
    if (driver.nextCursor.kind === "Absent") {
      setState({ kind: "Complete", itemCount: driver.itemCount });
      return;
    }

    const requestCursor = driver.nextCursor.value;
    if (driver.visitedCursors.has(requestCursor)) {
      setDefect(
        new Error(`Collection cursor cycle at ${JSON.stringify(requestCursor)}`),
      );
      return;
    }

    driver.visitedCursors.add(requestCursor);
    driver.inFlight = true;
    const controller = new AbortController();
    driver.controller = controller;
    const { generation, collectionRevision: requestRevision } = driver;
    setState({ kind: "Draining", loadedCount: driver.itemCount });

    void requestWithRetry(
      (signal) => loadPageRef.current(requestCursor, requestRevision, signal),
      controller.signal,
    ).then(
      (page) => {
        const current = driverRef.current;
        if (
          controller.signal.aborted ||
          current !== driver ||
          current.generation !== generation
        ) {
          return;
        }
        driver.inFlight = false;
        driver.controller = null;

        if (page.collectionRevision !== requestRevision) {
          const error = new ApiError(
            409,
            "E_COLLECTION_CHANGED",
            "Collection revision changed while loading",
          );
          setState({
            kind: "RefreshRequired",
            reason: "CollectionChanged",
            error,
            refresh: () => refreshRef.current(),
          });
          return;
        }

        try {
          const committedCount = commitPageRef.current(page);
          if (
            !Number.isSafeInteger(committedCount) ||
            committedCount < driver.itemCount
          ) {
            throw new Error(
              "Collection continuation commit returned an invalid item count",
            );
          }
          driver.itemCount = committedCount;
        } catch (error) {
          setDefect(collectionDefect(error));
          return;
        }
        driver.nextCursor = page.nextCursor;
        if (page.nextCursor.kind === "Absent") {
          setState({ kind: "Complete", itemCount: driver.itemCount });
          return;
        }
        setState({ kind: "Draining", loadedCount: driver.itemCount });
        startRef.current();
      },
      (error: unknown) => {
        const current = driverRef.current;
        if (
          controller.signal.aborted ||
          current !== driver ||
          current.generation !== generation ||
          isAbortError(error)
        ) {
          return;
        }
        driver.inFlight = false;
        driver.controller = null;

        if (handleUnauthenticatedRef.current(error)) {
          return;
        }
        if (!isApiError(error)) {
          setDefect(collectionDefect(error));
          return;
        }
        if (error.code === "E_COLLECTION_CHANGED") {
          setState({
            kind: "RefreshRequired",
            reason: "CollectionChanged",
            error,
            refresh: () => refreshRef.current(),
          });
          return;
        }
        if (error.code === "E_INVALID_CURSOR") {
          setState({
            kind: "RefreshRequired",
            reason: "InvalidCursor",
            error,
            refresh: () => refreshRef.current(),
          });
          return;
        }
        if (error.status === 0 || error.status >= 500) {
          driver.visitedCursors.delete(requestCursor);
          setState({
            kind: "ResumeFailed",
            error,
            retry: () => {
              if (driverRef.current !== driver) return;
              setState({
                kind: "Draining",
                loadedCount: driver.itemCount,
              });
              startRef.current();
            },
          });
          return;
        }
        setDefect(error);
      },
    );
  }, []);
  startRef.current = start;

  useLayoutEffect(() => {
    generationRef.current += 1;
    const previous = driverRef.current;
    previous?.controller?.abort();
    const seed = seedRef.current;

    const driver: Driver = {
      generation: generationRef.current,
      collectionRevision: seed.collectionRevision,
      visitedCursors: new Set(),
      nextCursor: seed.cursor,
      itemCount: seed.itemCount,
      inFlight: false,
      controller: null,
    };
    driverRef.current = driver;
    setDefect(null);
    setState(
      seed.cursor.kind === "Absent"
        ? { kind: "Complete", itemCount: seed.itemCount }
        : { kind: "Draining", loadedCount: seed.itemCount },
    );

    return () => {
      if (driverRef.current === driver) {
        driver.controller?.abort();
      }
    };
  }, [chainKey]);

  useEffect(() => {
    if (active) {
      startRef.current();
    }
  }, [active, chainKey]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (isVisible()) {
        startRef.current();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  if (defect !== null) {
    throw defect;
  }
  return state;
}
