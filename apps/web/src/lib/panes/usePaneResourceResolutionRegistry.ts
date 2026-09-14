"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  isApiError,
  isSameSystemApiDefect,
  type ApiError,
} from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { ResourceItem } from "@/lib/resources/resourceItems";
import { resolveResourceLocators } from "@/lib/resources/resourceLocators";
import {
  paneResourceLocatorKey,
  samePaneResourceLocator,
  type PaneResourceLocator,
} from "./paneResourceLocator";

export type PaneResourceResolutionState =
  | { readonly kind: "Pending" }
  | {
      readonly kind: "Resolved";
      readonly status: "ready" | "missing";
      readonly item: ResourceItem;
      readonly documentReader: boolean;
    }
  | {
      readonly kind: "Failed";
      readonly status: "unauthorized" | "invalid" | "error";
      readonly error: ApiError;
    }
  /** A malformed or same-system response, held against the locators of the one
   *  batch that asked for it. It is never a resource status and never a
   *  retryable result: `ThrowPaneResourceDefect` raises the original cause
   *  inside the owning pane's boundary, which reports it. */
  | { readonly kind: "Defected"; readonly cause: unknown };

/** Raises one pane's resolution defect from inside that pane's error boundary,
 *  so the failure is contained there and reported by its `componentDidCatch`. */
export function ThrowPaneResourceDefect({
  cause,
}: {
  readonly cause: unknown;
}): never {
  throw cause;
}

interface RegistryEntry {
  readonly locator: PaneResourceLocator;
  state: PaneResourceResolutionState;
  requesting: boolean;
}

const PENDING: PaneResourceResolutionState = { kind: "Pending" };

function operationalFailure(error: unknown): {
  readonly status: Extract<
    PaneResourceResolutionState,
    { kind: "Failed" }
  >["status"];
  readonly error: ApiError;
} | null {
  if (!isApiError(error) || isSameSystemApiDefect(error)) return null;
  if (error.status === 401 || error.status === 403) {
    return { status: "unauthorized", error };
  }
  if (error.status === 400 || error.status === 404 || error.status === 422) {
    return { status: "invalid", error };
  }
  return { status: "error", error };
}

export function usePaneResourceResolutionRegistry(
  locatorsByKey: ReadonlyMap<string, PaneResourceLocator>,
): {
  readonly statesByKey: ReadonlyMap<string, PaneResourceResolutionState>;
  readonly retry: (key: string) => void;
} {
  for (const [key, locator] of locatorsByKey) {
    if (paneResourceLocatorKey(locator) !== key) {
      throw new TypeError(`Pane resource locator key does not match ${key}`);
    }
  }

  const entriesRef = useRef<Map<string, RegistryEntry>>(new Map());
  const controllersRef = useRef<
    Map<AbortController, readonly [string, RegistryEntry][]>
  >(new Map());
  const mountedRef = useRef(true);
  const [statesByKey, setStatesByKey] = useState<
    ReadonlyMap<string, PaneResourceResolutionState>
  >(() => new Map());

  const publish = useCallback(() => {
    if (!mountedRef.current) return;
    setStatesByKey(
      new Map(
        [...entriesRef.current].map(([key, entry]) => [key, entry.state]),
      ),
    );
  }, []);

  const run = useCallback(
    (requests: readonly [string, RegistryEntry][]) => {
      if (requests.length === 0) return;
      for (const [, request] of requests) request.requesting = true;
      const controller = new AbortController();
      controllersRef.current.set(controller, requests);
      void resolveResourceLocators(
        requests.map(([, entry]) => entry.locator),
        { signal: controller.signal },
      )
        .then((resolutions) => {
          if (!mountedRef.current || controller.signal.aborted) return;
          requests.forEach(([key, request], index) => {
            if (entriesRef.current.get(key) !== request) return;
            const item = resolutions[index]!.resourceItem;
            request.state = {
              kind: "Resolved",
              status: item.missing ? "missing" : "ready",
              item,
              documentReader: resolutions[index]!.documentReader,
            };
          });
          publish();
        })
        .catch((error: unknown) => {
          if (!mountedRef.current || controller.signal.aborted) return;
          const failure = operationalFailure(error);
          if (failure !== null) handleUnauthenticatedApiError(error);
          // justify-defect: a malformed or same-system resolution means this
          // client and the api disagree about the wire. It is contained to the
          // locators of this batch — the only panes whose resource it answers.
          const state: PaneResourceResolutionState =
            failure === null
              ? { kind: "Defected", cause: error }
              : { kind: "Failed", ...failure };
          for (const [key, request] of requests) {
            if (entriesRef.current.get(key) !== request) continue;
            request.state = state;
          }
          publish();
        })
        .finally(() => {
          for (const [key, request] of requests) {
            if (entriesRef.current.get(key) === request) {
              request.requesting = false;
            }
          }
          controllersRef.current.delete(controller);
        });
    },
    [publish],
  );

  useEffect(() => {
    const entries = entriesRef.current;
    const controllers = controllersRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const [key, entry] of entries) {
        if (entry.state.kind !== "Pending") continue;
        entries.set(key, { ...entry, requesting: false });
      }
      for (const controller of controllers.keys()) controller.abort();
      controllers.clear();
    };
  }, []);

  useEffect(() => {
    const requests: [string, RegistryEntry][] = [];
    let changed = false;
    for (const key of entriesRef.current.keys()) {
      if (locatorsByKey.has(key)) continue;
      entriesRef.current.delete(key);
      changed = true;
    }
    for (const [key, locator] of locatorsByKey) {
      const current = entriesRef.current.get(key);
      if (current && samePaneResourceLocator(current.locator, locator)) {
        if (current.state.kind === "Pending" && !current.requesting) {
          requests.push([key, current]);
        }
        continue;
      }
      const entry: RegistryEntry = {
        locator,
        state: PENDING,
        requesting: false,
      };
      entriesRef.current.set(key, entry);
      requests.push([key, entry]);
      changed = true;
    }
    for (const [controller, batch] of controllersRef.current) {
      if (batch.some(([key, entry]) => entriesRef.current.get(key) === entry)) {
        continue;
      }
      controller.abort();
      controllersRef.current.delete(controller);
    }
    if (changed) publish();
    run(requests);
  }, [locatorsByKey, publish, run]);

  const retry = useCallback(
    (key: string) => {
      const current = entriesRef.current.get(key);
      if (!current || current.state.kind !== "Failed") return;
      const replacement: RegistryEntry = {
        locator: current.locator,
        state: PENDING,
        requesting: false,
      };
      entriesRef.current.set(key, replacement);
      publish();
      run([[key, replacement]]);
    },
    [publish, run],
  );

  return { statesByKey, retry };
}
