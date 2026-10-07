"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ApiError } from "@/lib/api/client";
import { lecternSuggestionsResource, librarySuggestionsResource } from "@/lib/api/resource";
import { useResource } from "@/lib/api/useResource";
import { getLecternSuggestions, getLibrarySuggestions } from "@/lib/suggestions/client";
import type {
  ResourceRefUri,
  SuggestionItem,
  SuggestionsSnapshot,
  SuggestionTarget,
} from "@/lib/suggestions/contract";
import { assertNever } from "@/lib/assertNever";

export type SuggestionsDestination =
  { kind: "Lectern" } | { kind: "Library"; id: string; name: string };

export type UnknownRecovery =
  | { kind: "Local"; retry: () => void }
  | { kind: "External"; owner: "LecternMutationNotice" };

export type AcceptResult =
  | { kind: "Accepted" }
  | { kind: "Rejected"; error: ApiError }
  | { kind: "Abandoned" };

export interface AcceptOptions {
  signal: AbortSignal;
  onUnknown: (outcome: { error: ApiError; recovery: UnknownRecovery }) => void;
}

export type SuggestionsAccept = (
  target: SuggestionTarget,
  options: AcceptOptions,
) => Promise<AcceptResult>;

export interface SuggestionsAddOptions {
  isFocusOwned: () => boolean;
}

export type SuggestionsState =
  | { kind: "InitialLoading" }
  | { kind: "InitialFailed"; error: ApiError; retry: () => void }
  | { kind: "Ready"; items: SuggestionItem[] }
  | { kind: "Refreshing"; items: SuggestionItem[] }
  | {
      kind: "RefreshFailed";
      items: SuggestionItem[];
      error: ApiError;
      retry: () => void;
    }
  | {
      kind: "Adding";
      items: SuggestionItem[];
      acceptedRef: ResourceRefUri;
      acceptedIndex: number;
    }
  | { kind: "AddFailed"; items: SuggestionItem[]; error: ApiError }
  | {
      kind: "AddUnknown";
      items: SuggestionItem[];
      error: ApiError;
      recovery: UnknownRecovery;
    }
  | { kind: "Refilling"; survivors: SuggestionItem[] }
  | {
      kind: "RefillFailed";
      survivors: SuggestionItem[];
      error: ApiError;
      retry: () => void;
    };

type QueryIntent =
  | { kind: "Initial" }
  | { kind: "Refresh"; items: SuggestionItem[] }
  | {
      kind: "Refill";
      survivors: SuggestionItem[];
      acceptedRef: ResourceRefUri;
    };

export interface SuggestionsFocusRequest {
  survivorRef: ResourceRefUri | null;
}

export interface SuggestionsController {
  state: SuggestionsState;
  add: (item: SuggestionItem, options: SuggestionsAddOptions) => void;
  focusRequest: SuggestionsFocusRequest | null;
}

function visibleItems(state: SuggestionsState): SuggestionItem[] | null {
  switch (state.kind) {
    case "InitialLoading":
    case "InitialFailed":
      return null;
    case "Ready":
    case "Refreshing":
    case "RefreshFailed":
    case "Adding":
    case "AddFailed":
    case "AddUnknown":
      return state.items;
    case "Refilling":
    case "RefillFailed":
      return state.survivors;
    default:
      return assertNever(state);
  }
}

export function mergeSuggestionsAfterAdd(
  survivors: SuggestionItem[],
  acceptedRef: ResourceRefUri,
  fresh: SuggestionItem[],
): SuggestionItem[] {
  const survivorRefs = new Set(survivors.map((item) => item.target.ref));
  const replacement = fresh.find(
    (item) =>
      item.target.ref !== acceptedRef && !survivorRefs.has(item.target.ref),
  );
  return replacement === undefined ? survivors : [...survivors, replacement];
}

function destinationKey(destination: SuggestionsDestination): string {
  switch (destination.kind) {
    case "Lectern":
      return "Lectern";
    case "Library":
      return `Library:${destination.id}`;
    default:
      return assertNever(destination);
  }
}

function isReadParked(state: SuggestionsState): boolean {
  return state.kind === "Adding" || state.kind === "AddUnknown";
}

export function useSuggestions({
  destination,
  isActive,
  accept,
}: {
  destination: SuggestionsDestination;
  isActive: boolean;
  accept: SuggestionsAccept;
}): SuggestionsController {
  const key = destinationKey(destination);
  // Destination props can change without a host remount. Ownership is checked
  // during render so the previous destination cannot paint, accept input, or
  // install its still-ready useResource value before the reset effect commits.
  const stateOwnerKeyRef = useRef(key);
  const destinationChangedAtRender = stateOwnerKeyRef.current !== key;
  const [storedState, setState] = useState<SuggestionsState>({
    kind: "InitialLoading",
  });
  const state: SuggestionsState = destinationChangedAtRender
    ? { kind: "InitialLoading" }
    : storedState;
  const stateRef = useRef(state);
  stateRef.current = state;
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [storedFocusRequest, setFocusRequest] =
    useState<SuggestionsFocusRequest | null>(null);
  const focusRequest = destinationChangedAtRender ? null : storedFocusRequest;
  const queryIntentRef = useRef<QueryIntent>({ kind: "Initial" });
  const loadStartedVersionRef = useRef<number | null>(null);
  const pendingActivationRef = useRef(false);
  const previousActiveRef = useRef(isActive);
  const activeAtRenderRef = useRef(isActive);
  activeAtRenderRef.current = isActive;
  const operationRef = useRef(0);
  const addInFlightRef = useRef(false);
  const observerRef = useRef<AbortController | null>(null);

  const activationSupersedesRefillFailure =
    state.kind === "RefillFailed" && queryIntentRef.current.kind === "Refill";
  const activationBlockedByAdd =
    addInFlightRef.current && !activationSupersedesRefillFailure;
  const activationWillRefresh =
    isActive &&
    !previousActiveRef.current &&
    !activationBlockedByAdd &&
    visibleItems(state) !== null &&
    state.kind !== "Refilling" &&
    !isReadParked(state);
  // The Add guard is claimed synchronously, before its state update commits.
  // Keep a render caused by an activation boundary from briefly reopening the
  // read lane. Refills retain the guard while legitimately owning that lane.
  const addOwnsLaneBeforeCommit =
    addInFlightRef.current &&
    state.kind !== "Refilling" &&
    state.kind !== "RefillFailed";
  const readEnabled =
    isActive &&
    !activationWillRefresh &&
    !addOwnsLaneBeforeCommit &&
    state.kind !== "Adding" &&
    state.kind !== "AddUnknown" &&
    state.kind !== "AddFailed";
  const requestRefreshVersion = destinationChangedAtRender ? 0 : refreshVersion;
  const lecternParams =
    readEnabled && destination.kind === "Lectern"
      ? { refreshVersion: requestRefreshVersion }
      : null;
  const libraryParams =
    readEnabled && destination.kind === "Library"
      ? { id: destination.id, refreshVersion: requestRefreshVersion }
      : null;
  const lecternResource = useResource<
    SuggestionsSnapshot,
    { refreshVersion: number }
  >({
    descriptor: lecternSuggestionsResource,
    params: lecternParams,
    load: ({ refreshVersion: requestedVersion }, signal) => {
      loadStartedVersionRef.current = requestedVersion;
      return getLecternSuggestions(signal);
    },
  });
  const libraryResource = useResource<
    SuggestionsSnapshot,
    { id: string; refreshVersion: number }
  >({
    descriptor: librarySuggestionsResource,
    params: libraryParams,
    load: ({ id, refreshVersion: requestedVersion }, signal) => {
      loadStartedVersionRef.current = requestedVersion;
      return getLibrarySuggestions(id, signal);
    },
  });
  const resource =
    destination.kind === "Lectern" ? lecternResource : libraryResource;

  const beginQuery = useCallback((intent: QueryIntent) => {
    queryIntentRef.current = intent;
    setRefreshVersion((version) => version + 1);
  }, []);

  const retryRead = useCallback(
    (intent: QueryIntent) => {
      if (
        stateOwnerKeyRef.current !== key ||
        queryIntentRef.current !== intent
      ) {
        return;
      }

      const current = stateRef.current;
      switch (intent.kind) {
        case "Initial":
          if (current.kind !== "InitialFailed" || addInFlightRef.current)
            return;
          setState({ kind: "InitialLoading" });
          break;
        case "Refresh":
          if (current.kind !== "RefreshFailed" || addInFlightRef.current)
            return;
          setState({ kind: "Refreshing", items: intent.items });
          break;
        case "Refill":
          if (current.kind !== "RefillFailed") return;
          setState({ kind: "Refilling", survivors: intent.survivors });
          break;
        default:
          assertNever(intent);
      }
      if (resource.status === "error") {
        resource.retry();
      } else {
        setRefreshVersion((version) => version + 1);
      }
    },
    [key, resource],
  );

  useLayoutEffect(() => {
    operationRef.current += 1;
    observerRef.current?.abort();
    observerRef.current = null;
    stateOwnerKeyRef.current = key;
    queryIntentRef.current = { kind: "Initial" };
    loadStartedVersionRef.current = null;
    pendingActivationRef.current = false;
    addInFlightRef.current = false;
    previousActiveRef.current = activeAtRenderRef.current;
    setRefreshVersion(0);
    setFocusRequest(null);
    setState({ kind: "InitialLoading" });
    return () => {
      operationRef.current += 1;
      observerRef.current?.abort();
      observerRef.current = null;
    };
  }, [key]);

  useEffect(() => {
    const wasActive = previousActiveRef.current;
    previousActiveRef.current = isActive;
    if (!isActive || wasActive) return;

    const current = stateRef.current;
    const canSupersedeRefillFailure =
      current.kind === "RefillFailed" &&
      queryIntentRef.current.kind === "Refill";
    if (
      (addInFlightRef.current && !canSupersedeRefillFailure) ||
      isReadParked(current) ||
      current.kind === "Refilling"
    ) {
      pendingActivationRef.current = true;
      return;
    }
    const items = visibleItems(current);
    if (items !== null && current.kind !== "InitialLoading") {
      if (current.kind === "RefillFailed") {
        addInFlightRef.current = false;
      }
      setState({ kind: "Refreshing", items });
      beginQuery({ kind: "Refresh", items });
    }
  }, [beginQuery, isActive]);

  useEffect(() => {
    if (destinationChangedAtRender) return;
    if (!isActive) return;
    if (
      refreshVersion !== 0 &&
      loadStartedVersionRef.current !== refreshVersion
    ) {
      return;
    }
    if (resource.status === "idle" || resource.status === "loading") return;

    const intent = queryIntentRef.current;
    if (resource.status === "error") {
      switch (intent.kind) {
        case "Initial":
          setState({
            kind: "InitialFailed",
            error: resource.error,
            retry: () => retryRead(intent),
          });
          break;
        case "Refresh":
          setState({
            kind: "RefreshFailed",
            items: intent.items,
            error: resource.error,
            retry: () => retryRead(intent),
          });
          break;
        case "Refill":
          setState({
            kind: "RefillFailed",
            survivors: intent.survivors,
            error: resource.error,
            retry: () => retryRead(intent),
          });
          break;
        default:
          assertNever(intent);
      }
      return;
    }

    switch (intent.kind) {
      case "Initial":
        setState({ kind: "Ready", items: resource.data.items });
        break;
      case "Refresh":
        setState({ kind: "Ready", items: resource.data.items });
        addInFlightRef.current = false;
        break;
      case "Refill":
        setState({
          kind: "Ready",
          items: mergeSuggestionsAfterAdd(
            intent.survivors,
            intent.acceptedRef,
            resource.data.items,
          ),
        });
        addInFlightRef.current = false;
        break;
      default:
        assertNever(intent);
    }
    pendingActivationRef.current = false;
  }, [
    destinationChangedAtRender,
    isActive,
    refreshVersion,
    resource,
    retryRead,
  ]);

  const add = useCallback(
    (item: SuggestionItem, options: SuggestionsAddOptions) => {
      if (stateOwnerKeyRef.current !== key) return;
      const current = stateRef.current;
      const items = visibleItems(current);
      if (
        addInFlightRef.current ||
        items === null ||
        current.kind === "Adding" ||
        current.kind === "AddUnknown" ||
        current.kind === "Refilling" ||
        current.kind === "RefillFailed"
      ) {
        return;
      }
      const acceptedIndex = items.findIndex(
        (candidate) => candidate.target.ref === item.target.ref,
      );
      if (acceptedIndex < 0) return;

      const operationOwnerKey = key;
      const operation = operationRef.current + 1;
      operationRef.current = operation;
      // Invalidate a refresh synchronously, before React can commit the state
      // change that aborts its GET. A resolution in that boundary must never
      // install Ready over this Add or its parked unknown outcome.
      loadStartedVersionRef.current = null;
      addInFlightRef.current = true;
      setFocusRequest(null);
      const observer = new AbortController();
      observerRef.current?.abort();
      observerRef.current = observer;
      const ownsOperation = () =>
        stateOwnerKeyRef.current === operationOwnerKey &&
        operationRef.current === operation &&
        !observer.signal.aborted;
      setState({
        kind: "Adding",
        items,
        acceptedRef: item.target.ref,
        acceptedIndex,
      });

      void accept(item.target, {
        signal: observer.signal,
        onUnknown: ({ error, recovery }) => {
          if (!ownsOperation()) return;
          const ownedRecovery: UnknownRecovery =
            recovery.kind === "External"
              ? recovery
              : {
                  kind: "Local",
                  retry: () => {
                    if (!ownsOperation()) return;
                    setState({
                      kind: "Adding",
                      items,
                      acceptedRef: item.target.ref,
                      acceptedIndex,
                    });
                    recovery.retry();
                  },
                };
          setState({
            kind: "AddUnknown",
            items,
            error,
            recovery: ownedRecovery,
          });
        },
      }).then((result) => {
        if (!ownsOperation()) return;
        observerRef.current = null;
        switch (result.kind) {
          case "Accepted": {
            const survivors = items.filter(
              (candidate) => candidate.target.ref !== item.target.ref,
            );
            if (activeAtRenderRef.current && options.isFocusOwned()) {
              setFocusRequest({
                survivorRef:
                  survivors[acceptedIndex]?.target.ref ??
                  survivors.at(-1)?.target.ref ??
                  null,
              });
            }
            setState({ kind: "Refilling", survivors });
            beginQuery({
              kind: "Refill",
              survivors,
              acceptedRef: item.target.ref,
            });
            break;
          }
          case "Rejected":
            addInFlightRef.current = false;
            pendingActivationRef.current = false;
            setState({ kind: "AddFailed", items, error: result.error });
            break;
          case "Abandoned":
            addInFlightRef.current = false;
            break;
          default:
            assertNever(result);
        }
      });
    },
    [accept, beginQuery, key],
  );

  return { state, add, focusRequest };
}

export type SuggestionsErrorContext =
  "initial" | "refresh" | "add" | "unknown" | "refill";

export function suggestionsErrorMessage(
  context: SuggestionsErrorContext,
  error: ApiError,
): string {
  switch (context) {
    case "initial":
      return "Couldn’t load suggestions.";
    case "refresh":
      return "Couldn’t refresh suggestions.";
    case "add":
      return error.message || "Couldn’t add this item.";
    case "unknown":
      return "Couldn’t confirm Add.";
    case "refill":
      return "Added, but couldn’t refill suggestions.";
    default:
      return assertNever(context);
  }
}
