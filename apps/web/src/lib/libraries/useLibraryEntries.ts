"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import {
  type ApiError,
  apiFetch,
  isApiError,
  isInvalidViewError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import {
  NO_CURSOR,
  ZERO_REVISION,
  type CollectionCursor,
  type CollectionPage,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import type { Presence } from "@/lib/api/presence";
import { present } from "@/lib/api/presence";
import { requestWithRetry } from "@/lib/api/retryPolicy";
import { libraryEntriesResource, libraryResource } from "@/lib/api/resource";
import { clientResourceFetcher } from "@/lib/api/resourceTransport.client";
import { useResource } from "@/lib/api/useResource";
import { useExhaustivePagination } from "@/lib/api/useExhaustivePagination";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { usePaneRouter } from "@/lib/panes/paneRuntime";
import { paneResourceLoaders, type LibraryPaneSeed } from "@/lib/panes/paneResourceLoaders";
import { useRevalidationSettlement } from "@/lib/panes/useRevalidationSettlement";
import usePaneScrollRetention from "@/lib/panes/usePaneScrollRetention";
import {
  definePaneVisitDataKey,
  useClearAllPaneVisitData,
  usePaneReturnReady,
  usePaneVisitData,
} from "@/lib/workspace/paneReturnMemento";
import {
  metadataCollectionSnapshot,
  useMetadataCollectionRevision,
} from "@/lib/media/mediaMetadataOperations";
import {
  consumptionProjectionSnapshot,
  useConsumptionProjectionRevision,
  type ConsumptionProjectionChange,
} from "@/lib/consumption/projectionRevision";
import {
  confirmedLibraryEntriesRevision,
  subscribePodcastSubscriptionSettingsInstalls,
} from "@/lib/podcasts/subscriptionSettings";
import { useMediaQueryRevision } from "@/lib/media/MediaSummaryProvider";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import type { LibraryOut } from "./contract";
import { libraryEntryPageFromWire, type LibraryEntryListItem } from "./entryListItem";
import {
  CANONICAL_LIBRARY_VIEW,
  completionOf,
  decodeLibraryView,
  encodeLibraryView,
  isInitialLibraryView,
  type LibraryEntryView,
} from "./libraryView";
import {
  libraryPlacementAffectedSince,
  libraryPlacementSnapshot,
  publishLibraryPlacementChange,
  useLibraryPlacementRevision,
} from "./placementRevision";
import { libraryRequestErrorMessage } from "./libraryRequestErrorMessage";

interface Facts {
  query: number;
  metadata: number;
  placement: number;
  consumption: ConsumptionProjectionChange;
}
interface Snapshot {
  library: LibraryOut;
  entries: {
    view: LibraryEntryView;
    entries: readonly LibraryEntryListItem[];
    collectionRevision: CollectionRevision;
    nextCursor: Presence<CollectionCursor>;
    revisions: Facts;
  };
}
interface Replacement {
  serial: number;
  id: string;
  view: LibraryEntryView;
  reason: "View" | "Reconcile";
  recovery: "Retry" | "RefreshList";
  facts: Facts;
  page?: CollectionPage<LibraryEntryListItem>;
  error?: ApiError;
}
const VISIT_DATA = definePaneVisitDataKey<Snapshot>("Library.Entries");
const targetId = (entry: LibraryEntryListItem) =>
  entry.kind === "media" ? entry.media.id : entry.podcast.id;

export function useLibraryEntries({ id, active, regionRef }: {
  readonly id: string;
  readonly active: boolean;
  readonly regionRef: RefObject<HTMLElement | null>;
}) {
  const router = usePaneRouter();
  const { accountId } = useAuthenticatedAccount();
  const confirmedRevision = useSyncExternalStore(
    subscribePodcastSubscriptionSettingsInstalls,
    useCallback(() => confirmedLibraryEntriesRevision(accountId), [accountId]),
    () => ZERO_REVISION,
  );
  const metadata = useMetadataCollectionRevision();
  const placement = useLibraryPlacementRevision();
  const consumption = useConsumptionProjectionRevision();
  const queryRevision = useMediaQueryRevision();
  const factsNow = useCallback((): Facts => ({
    query: queryRevision,
    metadata: metadataCollectionSnapshot(),
    placement: libraryPlacementSnapshot().revision,
    consumption: consumptionProjectionSnapshot(),
  }), [queryRevision]);
  const codec = useMemo(() => ({
    basePath: `/libraries/${id}`,
    decode: decodeLibraryView,
    encode: (value: ReturnType<typeof decodeLibraryView>, params: URLSearchParams) => {
      if (value.kind === "Valid") return encodeLibraryView(value.view, params);
      const next = new URLSearchParams(params);
      for (const key of ["sort", "direction", "completion", "projection", "entry_type", "kind", "type", "types"]) {
        next.delete(key);
      }
      return next;
    },
  }), [id]);
  const { state: view, setState: setUrlView } = usePaneUrlState(codec);
  const captureRef = useRef<Snapshot | null>(null);
  const capture = useCallback(() => captureRef.current, []);
  const restored = usePaneVisitData(VISIT_DATA, capture);
  const initial = useRef(restored !== null &&
    restored.entries.collectionRevision >= confirmedRevision
    ? restored : null).current;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(initial);
  const [unavailableId, setUnavailableId] = useState<string | null>(null);
  const [request, setRequest] = useState<Replacement | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const [chain, setChain] = useState(0);
  const [reorderBusy, setReorderBusy] = useState(false);
  const serial = useRef(0);
  const reorderGeneration = useRef(0);
  const mounted = useRef(true);
  const unknownPending = useRef(false);
  const adoptSeed = useRef(initial === null);
  const completedRefresh = useRef<number | null>(null);

  const clearVisitData = useClearAllPaneVisitData();
  const scroll = usePaneScrollRetention(regionRef, snapshot);
  const settlement = useRevalidationSettlement();
  const bootstrap = useResource<LibraryPaneSeed, { id: string }>({
    descriptor: libraryResource,
    params: initial === null ? { id } : null,
    load: (params, signal) =>
      paneResourceLoaders.library!.load(clientResourceFetcher(signal), params) as Promise<LibraryPaneSeed>,
  });
  const library = snapshot?.library.id === id
    ? snapshot.library
    : unavailableId !== id && bootstrap.status === "ready" && bootstrap.data.library.id === id
      ? bootstrap.data.library
      : null;
  const keyOf = useCallback((entryView: LibraryEntryView) => libraryEntriesResource.cacheKey({ id, view: entryView }), [id]);
  const requestedKey = view.kind === "Valid" ? keyOf(view.view) : null;
  const committedKey = snapshot?.library.id === id ? keyOf(snapshot.entries.view) : null;
  const seedClaimable = adoptSeed.current &&
    (view.kind === "Invalid" || isInitialLibraryView(view.view)) &&
    metadata === 0 && placement.revision === 0 && consumption.revision === 0 && queryRevision === 0 &&
    (bootstrap.status !== "ready" || bootstrap.data.collectionRevision >= confirmedRevision);
  const ready = snapshot !== null && requestedKey !== null && requestedKey === committedKey &&
    request?.reason !== "View" && snapshot.entries.collectionRevision >= confirmedRevision;
  const latest = useRef({ id, snapshot, request, library, requestedKey, ready });
  latest.current = { id, snapshot, request, library, requestedKey, ready };
  const invalidateCapture = useCallback(() => {
    captureRef.current = null;
    clearVisitData();
    setChain(value => value + 1);
  }, [clearVisitData]);
  const begin = useCallback((
    reason: Replacement["reason"],
    entryView: LibraryEntryView,
    recovery: Replacement["recovery"] = "Retry",
  ) => {
    settlement.reject(new DOMException("Library refresh was superseded.", "AbortError"));
    completedRefresh.current = null;
    if (reason === "View") scroll();
    invalidateCapture();
    if (reason === "View") {
      reorderGeneration.current += 1;
      setReorderBusy(false);
    }
    const next: Replacement = {
      serial: ++serial.current, id, view: entryView, reason, recovery, facts: factsNow(),
    };
    latest.current.request = next;
    setRequest(next);
    return next.serial;
  }, [id, invalidateCapture, scroll, settlement, factsNow]);
  const stale = useCallback((facts: Facts, entryView: LibraryEntryView) => {
    const now = factsNow();
    return (now.placement !== facts.placement &&
      (latest.current.library?.isDefault === true || libraryPlacementAffectedSince(facts.placement, id))) ||
      (now.consumption.revision !== facts.consumption.revision &&
        (entryView.order.kind === "Remaining" || entryView.projection.kind === "InProgress" || completionOf(entryView) === "unfinished")) ||
      now.metadata !== facts.metadata || now.query !== facts.query;
  }, [id, factsNow]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      reorderGeneration.current += 1;
    };
  }, []);
  useEffect(() => {
    serial.current += 1;
    reorderGeneration.current += 1;
    unknownPending.current = false;
    setRequest(null);
    setChain(value => value + 1);
    settlement.reject(new DOMException("Library refresh source was replaced.", "AbortError"));
  }, [id, settlement]);
  useEffect(() => {
    if (bootstrap.status === "error") {
      if (bootstrap.error.status === 404) router.push("/libraries");
      setSnapshot(null);
      return;
    }
    if (bootstrap.status !== "ready" || !adoptSeed.current) return;
    adoptSeed.current = false;
    if ((view.kind === "Invalid" || isInitialLibraryView(view.view)) &&
      metadata === 0 && placement.revision === 0 && consumption.revision === 0 && queryRevision === 0 &&
      bootstrap.data.collectionRevision >= confirmedLibraryEntriesRevision(accountId)) {
      setSnapshot({
        library: bootstrap.data.library, entries: {
          view: view.kind === "Valid" ? view.view : CANONICAL_LIBRARY_VIEW,
          entries: bootstrap.data.entries,
          collectionRevision: bootstrap.data.collectionRevision,
          nextCursor: bootstrap.data.nextCursor,
          revisions: { query: 0, metadata: 0, placement: 0, consumption: { revision: 0, rowRevision: 0 } },
        }
      });
    }
  }, [bootstrap, router, view, metadata, placement.revision, consumption.revision, confirmedRevision, accountId, queryRevision]);
  useEffect(() => {
    if (view.kind === "Invalid" || unavailableId === id || seedClaimable) return;
    const needsPage = snapshot === null
      ? !isInitialLibraryView(view.view) || !adoptSeed.current || metadata !== 0 || placement.revision !== 0 || consumption.revision !== 0 || queryRevision !== 0
      : requestedKey !== committedKey || snapshot.entries.collectionRevision < confirmedLibraryEntriesRevision(accountId);
    if (needsPage && !(request?.reason === "View" && request.id === id && keyOf(request.view) === requestedKey)) {
      begin("View", view.view);
    }
  }, [id, view, snapshot, requestedKey, committedKey, request, metadata,
    placement.revision, consumption.revision, begin, keyOf, unavailableId, seedClaimable, confirmedRevision, accountId, queryRevision]);
  useEffect(() => {
    if (request === null || request.error || request.page) return;
    const current = request;
    const controller = new AbortController();
    const load = async (signal: AbortSignal) => {
      const retained = current.reason === "Reconcile" ? latest.current.snapshot?.entries.entries.length ?? 0 : 0;
      for (;;) {
        try {
          let page = libraryEntryPageFromWire((await apiFetch<ApiJson<"/libraries/{library_id}/entries", "get">>(
            libraryEntriesResource.clientPath({ id: current.id, view: current.view,
              limit: retained === 0 ? 100 : Math.min(100, retained) }), { signal },
          )).data);
          const items = [...page.items];
          while (items.length < retained && page.nextCursor.kind === "Present") {
            page = libraryEntryPageFromWire((await apiFetch<ApiJson<"/libraries/{library_id}/entries", "get">>(
              libraryEntriesResource.clientPath({ id: current.id, view: current.view,
                limit: Math.min(100, retained - items.length), cursor: page.nextCursor.value,
                collectionRevision: page.collectionRevision }), { signal },
            )).data);
            items.push(...page.items);
          }
          return { ...page, items };
        } catch (error) {
          if (signal.aborted || !isApiError(error) || error.code !== "E_COLLECTION_CHANGED") throw error;
        }
      }
    };
    void (current.reason === "View" ? requestWithRetry(load, controller.signal) : load(controller.signal)).then(page => {
      if (!controller.signal.aborted && serial.current === current.serial) {
        setRequest(value => value?.serial === current.serial ? { ...value, page } : value);
      }
    }, error => {
      if (controller.signal.aborted || isAbortError(error) || serial.current !== current.serial || handleUnauthenticatedApiError(error)) return;
      try {
        if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
        if (!(current.reason === "View" && isInvalidViewError(error))) {
          libraryRequestErrorMessage(error, { title: "Library entries couldn’t be refreshed", request: "EntryRead" });
        }
        setRequest(value => value?.serial === current.serial ? { ...value, error } : value);
        if (settlement.isPending(current.serial)) {
          settlement.reject(error);
          setRequest(null);
          captureRef.current = latest.current.snapshot;
        }
      } catch (unexpected) {
        setDefect({ error: unexpected });
      }
    });
    return () => controller.abort();
  }, [request, settlement]);
  useEffect(() => {
    if (!request?.page || request.serial !== serial.current || request.id !== id || keyOf(request.view) !== requestedKey || library === null) return;
    if (request.page.collectionRevision < confirmedLibraryEntriesRevision(accountId)) {
      begin(request.reason, request.view, request.recovery);
      return;
    }
    if (stale(request.facts, request.view)) {
      begin(request.reason, request.view, request.recovery);
      return;
    }
    if (request.reason === "Reconcile" && committedKey !== requestedKey) return;
    const next: Snapshot = {
      library, entries: {
        view: request.view,
        entries: request.page.items,
        collectionRevision: request.page.collectionRevision,
        nextCursor: request.page.nextCursor,
        revisions: request.reason === "View" ? factsNow() : request.facts,
      }
    };
    latest.current.snapshot = next;
    setSnapshot(next);
    if (settlement.isPending(request.serial)) completedRefresh.current = request.serial;
    setRequest(null);
    setChain(value => value + 1);
  }, [request, id, library, keyOf, requestedKey, committedKey, stale, begin, settlement, accountId, factsNow]);
  // a stale captured reconciliation starts its followup before refresh settlement.
  // beginning that request supersedes the waiter rather than announcing stale completion.
  useEffect(() => {
    if (!ready || snapshot === null || request !== null || latest.current.request !== null) return;
    if (unknownPending.current || stale(snapshot.entries.revisions, snapshot.entries.view)) {
      unknownPending.current = false;
      begin("Reconcile", snapshot.entries.view);
    }
  }, [metadata, placement.revision, consumption, queryRevision, ready, snapshot, request, stale, begin]);
  useLayoutEffect(() => {
    captureRef.current = ready && request === null && snapshot !== null &&
      snapshot.entries.collectionRevision >= confirmedLibraryEntriesRevision(accountId) ? snapshot : null;
  }, [ready, request, snapshot, accountId]);
  useEffect(() => {
    if (completedRefresh.current !== null && request === null && captureRef.current !== null) {
      settlement.resolve(completedRefresh.current);
      completedRefresh.current = null;
    }
  }, [snapshot, request, settlement]);
  useEffect(() => () => {
    settlement.reject(new DOMException("Library refresh source was replaced.", "AbortError"));
    completedRefresh.current = null;
  }, [requestedKey, settlement]);

  const refreshList = useCallback(() => {
    const current = latest.current;
    if (current.snapshot !== null && current.ready) {
      begin("Reconcile", current.snapshot.entries.view, "RefreshList");
    }
  }, [begin]);
  const revalidate = useCallback((signal: AbortSignal): Promise<void> => {
    if (signal.aborted) {
      return Promise.reject(signal.reason ?? new DOMException("Library refresh was aborted.", "AbortError"));
    }
    const current = latest.current;
    if (current.snapshot === null || !current.ready ||
      current.snapshot.entries.collectionRevision < confirmedLibraryEntriesRevision(accountId)) {
      return Promise.reject(new Error("Library refresh lost its exact committed view"));
    }
    const token = begin("Reconcile", current.snapshot.entries.view);
    return settlement.wait({
      requestId: token, signal,
      onAbort: () => {
        completedRefresh.current = null;
        serial.current += 1;
        setRequest(value => value?.serial === token ? null : value);
        captureRef.current = latest.current.snapshot;
      }
    });
  }, [begin, settlement, accountId]);
  useEffect(() => subscribePodcastSubscriptionSettingsInstalls(install => {
    if (install.kind !== "Settings") return;
    const settings = install.settings;
    if (settings.user_id !== accountId) return;
    const current = latest.current.snapshot;
    if (settings.libraryEntriesCollectionRevision < confirmedLibraryEntriesRevision(accountId) ||
      (current !== null && settings.libraryEntriesCollectionRevision < current.entries.collectionRevision)) return;
    invalidateCapture();
    if (current === null) return;
    const entries = current.entries.entries.map(entry =>
      entry.kind === "podcast" && entry.podcast.id === settings.podcast_id && entry.subscription.kind === "Present" ? {
        ...entry,
        podcast: { ...entry.podcast, syncStatus: present(settings.sync_status) },
        subscription: present({
          ...entry.subscription.value,
          defaultPlaybackSpeed: settings.default_playback_speed,
          pauseShorteningMode: settings.pause_shortening_mode,
          autoQueue: settings.auto_queue,
          syncStatus: settings.sync_status,
        }),
      } : entry);
    const next = { ...current, entries: { ...current.entries, entries, collectionRevision: settings.libraryEntriesCollectionRevision } };
    latest.current.snapshot = next;
    setSnapshot(next);
  }), [accountId, invalidateCapture]);
  const loadPage = useCallback(async (cursor: CollectionCursor, collectionRevision: CollectionRevision, signal: AbortSignal) => {
    const current = latest.current.snapshot;
    if (current === null) throw new Error("Library continuation lost its committed view");
    const page = libraryEntryPageFromWire((await apiFetch<ApiJson<"/libraries/{library_id}/entries", "get">>(
      libraryEntriesResource.clientPath({ id, view: current.entries.view, cursor, collectionRevision, limit: 100 }),
      { signal },
    )).data);
    if (latest.current.snapshot !== current || latest.current.request !== null ||
      stale(current.entries.revisions, current.entries.view)) {
      throw new DOMException("Library continuation was superseded.", "AbortError");
    }
    return page;
  }, [id, stale]);
  const commitPage = useCallback((page: CollectionPage<LibraryEntryListItem>) => {
    const current = latest.current.snapshot;
    if (current === null) throw new Error("Library continuation lost its committed view");
    if (page.collectionRevision < confirmedLibraryEntriesRevision(accountId)) return current.entries.entries.length;
    if (current.entries.collectionRevision !== page.collectionRevision) throw new Error("Library continuation revision mismatch");
    const entries = [...current.entries.entries];
    const ids = new Set(entries.map(targetId));
    for (const entry of page.items) {
      if (ids.has(targetId(entry))) continue;
      ids.add(targetId(entry));
      entries.push(entry);
    }
    const next = { ...current, entries: { ...current.entries, entries, nextCursor: page.nextCursor } };
    latest.current.snapshot = next;
    captureRef.current = next;
    setSnapshot(next);
    return entries.length;
  }, [accountId]);
  const exhaustion = useExhaustivePagination({
    active: active && ready && snapshot !== null && request === null,
    chainKey: `${id}:${requestedKey ?? "invalid"}:${committedKey ?? "uncommitted"}:${snapshot?.entries.collectionRevision ?? ZERO_REVISION}:${chain}`,
    cursor: snapshot?.entries.nextCursor ?? NO_CURSOR,
    collectionRevision: snapshot?.entries.collectionRevision ?? ZERO_REVISION,
    itemCount: snapshot?.entries.entries.length ?? 0,
    loadPage, commitPage,
    refresh: refreshList,
  });
  const handledCollectionChange = useRef<unknown>(null);
  useEffect(() => {
    if (request !== null || exhaustion.kind !== "RefreshRequired" ||
      exhaustion.reason !== "CollectionChanged" || handledCollectionChange.current === exhaustion.error) return;
    handledCollectionChange.current = exhaustion.error;
    refreshList();
  }, [request, exhaustion, refreshList]);
  const reorder = useCallback(async (entries: readonly LibraryEntryListItem[]) => {
    const current = latest.current;
    const saved = current.snapshot;
    if (!current.ready || saved === null ||
      saved.entries.collectionRevision < confirmedLibraryEntriesRevision(accountId) || saved.library.role !== "admin" ||
      !saved.library.canEditEntries || saved.library.isDefault ||
      saved.entries.view.order.kind !== "Canonical" ||
      saved.entries.view.projection.kind !== "AllItems" ||
      saved.entries.view.projection.completion !== "all" ||
      saved.entries.view.entryType.kind !== "AllTypes" ||
      saved.entries.nextCursor.kind !== "Absent" || exhaustion.kind !== "Complete") return;
    const generation = ++reorderGeneration.current;
    const capturedId = id;
    const capturedKey = current.requestedKey;
    const optimistic = { ...saved, entries: { ...saved.entries, entries } };
    latest.current.snapshot = optimistic;
    setSnapshot(optimistic);
    setReorderBusy(true);
    try {
      await apiFetch(`/api/libraries/${capturedId}/entries/reorder`, {
        method: "PATCH",
        body: JSON.stringify({
          entry_ids: entries.map(entry => {
            if (entry.placement.kind !== "Present") throw new Error("Virtual Library rows cannot be reordered");
            return entry.placement.value.libraryEntryId;
          })
        })
      });
      publishLibraryPlacementChange([capturedId]);
      if (!mounted.current || generation !== reorderGeneration.current ||
        latest.current.id !== capturedId || latest.current.requestedKey !== capturedKey) return;
      clearVisitData();
      const latestRequest = latest.current.request;
      if (latest.current.ready && latest.current.snapshot !== null && latestRequest === null) {
        begin("Reconcile", latest.current.snapshot.entries.view);
      } else if (latestRequest === null || latestRequest.facts.placement < libraryPlacementSnapshot().revision) {
        unknownPending.current = true;
      }
    } catch (error) {
      if (!mounted.current || generation !== reorderGeneration.current ||
        latest.current.id !== capturedId || latest.current.requestedKey !== capturedKey) return;
      const currentSnapshot = latest.current.snapshot;
      if (currentSnapshot !== null) {
        const rollback = { ...currentSnapshot, entries: { ...currentSnapshot.entries, entries: saved.entries.entries } };
        latest.current.snapshot = rollback;
        setSnapshot(rollback);
      }
      if (!handleUnauthenticatedApiError(error)) throw error;
    } finally {
      if (mounted.current && generation === reorderGeneration.current) setReorderBusy(false);
    }
  }, [id, exhaustion.kind, clearVisitData, begin, accountId]);
  const setView = useCallback((next: LibraryEntryView) => {
    setUrlView({ kind: "Valid", view: next });
    const current = latest.current.snapshot;
    if (current !== null && keyOf(current.entries.view) === keyOf(next)) {
      serial.current += 1;
      reorderGeneration.current += 1;
      settlement.reject(new DOMException("Library refresh was superseded.", "AbortError"));
      completedRefresh.current = null;
      scroll();
      invalidateCapture();
      setRequest(null);
      setReorderBusy(false);
    } else {
      begin("View", next);
    }
  }, [setUrlView, keyOf, settlement, scroll, invalidateCapture, begin]);
  const adoptLibrary = useCallback((next: LibraryOut | null) => {
    setUnavailableId(next === null ? id : null);
    setSnapshot(current => current === null || next === null
      ? null
      : current.library.id === next.id || next.id === id ? { ...current, library: next } : current);
  }, [id]);
  const invalid = view.kind === "Invalid" || (request?.reason === "View" && isInvalidViewError(request.error));
  const failure = request?.reason === "View" ? request.error : undefined;
  const state = invalid ? { kind: "Invalid" } as const
    : failure ? { kind: "Failed", request: "EntryRead", error: failure } as const
    : bootstrap.status === "error" && snapshot === null
      ? { kind: "Failed", request: "LibraryRead", error: bootstrap.error } as const
      : ready ? { kind: "Ready" } as const
      : snapshot !== null ? { kind: "Refreshing" } as const : { kind: "Loading" } as const;
  usePaneReturnReady(state.kind === "Ready" || state.kind === "Failed" || state.kind === "Invalid");
  if (defect !== null) throw defect.error;
  return {
    library,
    committed: snapshot?.library.id === id ? {
      library: snapshot.library,
      view: snapshot.entries.view,
      entries: snapshot.entries.entries,
      collectionRevision: snapshot.entries.collectionRevision,
      nextCursor: snapshot.entries.nextCursor,
    } : null,
    view, state,
    reconciliation: request?.reason === "Reconcile" ? { recovery: request.recovery, error: request.error ?? null } : null,
    exhaustion, reorderBusy, setView,
    resetView: () => setView(CANONICAL_LIBRARY_VIEW),
    retry: () => {
      if (request?.error) begin(request.reason, request.view, request.recovery);
      else if (bootstrap.status === "error") bootstrap.retry();
    },
    refreshList, revalidate, adoptLibrary, reorder,
  } as const;
}
