"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dispatchOpenLauncher } from "@/lib/launcher/launcherEvents";
import { ApiError, apiFetch, isApiError } from "@/lib/api/client";
import { present, type Presence } from "@/lib/api/presence";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  libraryEntriesResource,
  libraryResource as libraryResourceDescriptor,
  type LibraryEntriesResourceParams,
} from "@/lib/api/resource";
import { runSourceProcessingAction } from "@/lib/media/sourceActions";
import type { MediaActionCapabilities } from "@/lib/media/ingestionClient";
import type { DocumentProcessingStatus } from "@/lib/media/documentReadiness";
import {
  FeedbackNotice,
  toFeedback,
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { useConnectionsComposerController } from "@/components/connections/connectionsComposerController";
import { libraryResourceOptions } from "@/lib/actions/resourceActions";
import { useLectern } from "@/lib/lectern/LecternProvider";
import { parseMediaId } from "@/lib/lectern/contract";
import { presentMedia } from "@/lib/collections/presenters/media";
import { presentPodcast } from "@/lib/collections/presenters/podcast";
import { startResourceContextChat } from "@/lib/resources/resourceContextChat";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import {
  ensureMediaInLibraries,
  deleteMedia,
} from "@/lib/media/mediaLibraries";
import { useStringIdSet, type StringIdSet } from "@/lib/useStringIdSet";
import { clientResourceFetcher } from "@/lib/api/resourceTransport.client";
import { useResource } from "@/lib/api/useResource";
import { paneResourceLoaders } from "@/lib/panes/paneResourceLoaders";
import {
  addPodcastToLibrary,
} from "@/app/(authenticated)/podcasts/podcastSubscriptions";
import Button from "@/components/ui/Button";
import Select from "@/components/ui/Select";
import Toggle from "@/components/ui/Toggle";
import PaneSurface from "@/components/ui/PaneSurface";
import SectionOpener from "@/components/ui/SectionOpener";
import CollectionView from "@/components/collections/CollectionView";
import ReadingSlateSection from "@/components/collections/ReadingSlateSection";
import PaneToolbar from "@/components/ui/PaneToolbar";
import type { CollectionContext, CollectionRowView } from "@/lib/collections/types";
import type {
  PositiveCount,
  ProgressFraction,
} from "@/lib/consumption/activityFacts";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import type { PodcastSyncStatus } from "@/lib/status/podcastSync";
import { useConnectionSummaries } from "@/lib/collections/useConnectionSummaries";
import { useDebouncedFetch } from "@/lib/api/useDebouncedFetch";
import LibrarySettingsDialog from "@/components/LibrarySettingsDialog";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import {
  usePaneParam,
  usePaneRouter,
  usePaneRuntime,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import type { WorkspaceSecondaryActivation } from "@/lib/panes/paneSecondaryModel";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";
import {
  decodeLibraryView,
  encodeLibraryView,
  orderPresetIdsFor,
  orderToPresetId,
  presetIdToOrder,
  presetLabel,
  type DecodedLibraryView,
  type LibraryEntryView,
  type LibraryOrderPresetId,
} from "@/lib/libraries/libraryView";
import type { ContributorCredit } from "@/lib/contributors/types";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { useShareController } from "@/lib/sharing/controller";
import { paneShareOpenOptions } from "@/lib/sharing/openOptions";
import { resourceShareTarget } from "@/lib/sharing/targets";
import { isAbortError } from "@/lib/errors";
import {
  decodeLibraryReadingTimeEntry,
  type LibraryMediaKind,
  type ReadingTimeEstimatePresence,
} from "@/lib/libraries/readingTime";
import { slateTargetId } from "@/lib/resonance/contract";
import type { ReadingSlateAccept } from "@/lib/resonance/useReadingSlate";
import styles from "./LibraryPaneBody.module.css";

interface Library {
  id: string;
  name: string;
  color: string | null;
  isDefault: boolean;
  role: string;
  ownerUserHandle: string;
  systemKey: string | null;
  canRename: boolean;
  canDelete: boolean;
  canEditEntries: boolean;
  canManageMembers: boolean;
  canTransferOwnership: boolean;
}

interface LibraryMediaEntry {
  id: string;
  kind: LibraryMediaKind;
  title: string;
  // Instant the underlying media entered Nexus. Drives the "Added to Nexus …"
  // row line under the Added order for the default (virtual) library, where each
  // row keys by media rather than by physical library entry.
  created_at: string;
  contributors: ContributorCredit[];
  published_date: string | null;
  publicationDate: Presence<PublicationDate>;
  publisher: string | null;
  canonical_source_url: string | null;
  sourceHost: Presence<string>;
  processing_status: DocumentProcessingStatus;
  read_state: "unread" | "in_progress" | "finished";
  progress_fraction: number | null;
  progressFraction: Presence<ProgressFraction>;
  last_engaged_at?: string | null;
  capabilities: Partial<MediaActionCapabilities> &
    Pick<MediaActionCapabilities, "can_quote">;
}

type LibraryMediaConsumption = Pick<
  LibraryMediaEntry,
  "read_state" | "progress_fraction"
>;

interface LibraryPodcastEntry {
  id: string;
  title: string;
  contributors: ContributorCredit[];
  feed_url: string;
  website_url: string | null;
  image_url: string | null;
  unplayed_count: number;
  unplayedCount: Presence<PositiveCount>;
  publicationDate: Presence<PublicationDate>;
  syncStatus: Presence<PodcastSyncStatus>;
}

interface LibraryPodcastSubscription {
  status: "active" | "unsubscribed";
  sync_status:
    | "pending"
    | "running"
    | "partial"
    | "complete"
    | "source_limited"
    | "failed";
}

interface LibraryEntryBase {
  id: string;
  position: number;
  created_at: string;
  readingTimeEstimate: ReadingTimeEstimatePresence;
}

interface LibraryMediaListEntry extends LibraryEntryBase {
  kind: "media";
  media: LibraryMediaEntry;
}

interface LibraryPodcastListEntry extends LibraryEntryBase {
  kind: "podcast";
  podcast: LibraryPodcastEntry;
  subscription: LibraryPodcastSubscription | null;
}

type LibraryEntry = LibraryMediaListEntry | LibraryPodcastListEntry;

type LibraryMediaEntryWire = Omit<
  LibraryMediaEntry,
  "progressFraction" | "publicationDate" | "sourceHost"
>;
type LibraryPodcastEntryWire = Omit<
  LibraryPodcastEntry,
  "unplayedCount" | "publicationDate" | "syncStatus"
>;
type LibraryEntryWire =
  | (Omit<LibraryMediaListEntry, "media" | "readingTimeEstimate"> & {
      media: LibraryMediaEntryWire;
      readingTimeEstimate: unknown;
    })
  | (Omit<LibraryPodcastListEntry, "podcast" | "readingTimeEstimate"> & {
      podcast: LibraryPodcastEntryWire;
      readingTimeEstimate: unknown;
    });

interface LibraryPageInfo {
  has_more: boolean;
  next_cursor: string | null;
}

interface LibraryEntryPage {
  data: LibraryEntry[];
  page: LibraryPageInfo;
}

interface LibraryEntryPageWire {
  data: LibraryEntryWire[];
  page: LibraryPageInfo;
}

interface EntryReconciliationRequest {
  ownerId: string;
  view: LibraryEntryView;
  serial: number;
}

interface EntryReconciliationResult {
  request: EntryReconciliationRequest;
  page: LibraryEntryPage;
}

function decodeLibraryEntryPage(page: LibraryEntryPageWire): LibraryEntryPage {
  return {
    ...page,
    data: page.data.map(decodeLibraryReadingTimeEntry),
  };
}

interface LibraryPaneResource {
  library: Library;
  entries: LibraryEntry[];
  entriesPage: LibraryPageInfo;
}

// The default library's read surface is a deduplicated virtual set: the server
// can hand back a different representative entry id for the same underlying
// media across paginated fetches, so Default rows/merges key by `media.id`.
// Non-default libraries key by the physical entry id, unchanged.
function libraryRowKey(entry: LibraryEntry, isDefaultLibrary: boolean): string {
  return isDefaultLibrary && entry.kind === "media" ? entry.media.id : entry.id;
}

function appendUniqueEntries(
  current: LibraryEntry[],
  next: LibraryEntry[],
  keyOf: (entry: LibraryEntry) => string = (entry) => entry.id,
): LibraryEntry[] {
  const seen = new Set(current.map(keyOf));
  const merged = [...current];
  for (const entry of next) {
    const key = keyOf(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

function toLibraryAddError(error: unknown): ApiError {
  return isApiError(error)
    ? error
    : new ApiError(
        0,
        "E_NETWORK",
        error instanceof Error ? error.message : "Request failed",
      );
}

// The one full-date formatter for the "Added …" row line; the whole instant is
// formatted (not a date-only weekday folio), so it reads unambiguously.
const ADDED_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};

function formatAdded(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, ADDED_DATE_FORMAT).format(date);
}

// A canonical/all view is exactly the server's default order that the bootstrap
// `libraryResource` already seeded; any factual order or an unfinished filter is
// a different first page fetched from the entries endpoint.
function isInitialLibraryView(view: LibraryEntryView): boolean {
  return view.order.kind === "Canonical" && view.completion === "all";
}

// The one code that turns an entry fetch error into the "Invalid library view"
// terminal state: the backend rejects a bad request/cursor with these codes.
function isInvalidViewError(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.code === "E_INVALID_REQUEST" || error.code === "E_INVALID_CURSOR")
  );
}

const CANONICAL_VIEW: LibraryEntryView = {
  order: { kind: "Canonical" },
  completion: "all",
};

export default function LibraryPaneBody() {
  const id = usePaneParam("id");
  if (!id) {
    throw new Error("library route requires an id");
  }
  const router = usePaneRouter();
  const paneRuntime = usePaneRuntime();
  const { openInNewPane } = paneRuntime ?? {};
  const isPaneActive = paneRuntime?.isActive ?? true;
  const paneId = paneRuntime?.paneId ?? `library-${id}`;
  const { openShare } = useShareController();
  const feedback = useFeedback();
  const lectern = useLectern();

  // The pane URL owns the library view (order + completion) via a strict, total
  // codec; `decodedView` is a discriminated result and `view` is null only when
  // the URL is Invalid, which is a terminal, user-recoverable state.
  const libraryViewCodec = useMemo(
    () => ({
      basePath: `/libraries/${id}`,
      decode: (params: URLSearchParams): DecodedLibraryView =>
        decodeLibraryView(params),
      encode: (
        decoded: DecodedLibraryView,
        current: URLSearchParams,
      ): URLSearchParams => {
        if (decoded.kind === "Valid") {
          return encodeLibraryView(decoded.view, current);
        }
        const next = new URLSearchParams(current);
        next.delete("sort");
        next.delete("direction");
        next.delete("completion");
        return next;
      },
      replaceOptions: {
        viewTransition: { kind: "collection-reflow" } as const,
      },
    }),
    [id],
  );
  const { state: decodedView, setState: setDecodedView } =
    usePaneUrlState(libraryViewCodec);
  const view = decodedView.kind === "Valid" ? decodedView.view : null;
  const isInitialView = view !== null && isInitialLibraryView(view);
  // Stable per-view signature (independent of unrelated pane params): the view
  // key that resets and reloads the single paginated controller on any change.
  const viewSignature = view ? `${orderToPresetId(view.order)}:${view.completion}` : "invalid";
  const setView = useCallback(
    (next: LibraryEntryView) => setDecodedView({ kind: "Valid", view: next }),
    [setDecodedView],
  );

  const [library, setLibrary] = useState<Library | null>(null);
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [entryCursor, setEntryCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<FeedbackContent | null>(
    null,
  );
  // Set when an entry fetch for the current view is rejected as invalid; cleared
  // whenever the view changes. Renders the terminal "Invalid library view" state.
  const [viewInvalid, setViewInvalid] = useState(false);
  const removedEntryIds = useStringIdSet();
  const retryingMediaIds = useStringIdSet();
  const refreshingMediaIds = useStringIdSet();
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  const libraryEntriesStaleRef = useRef(false);
  const entryReconciliationOwnerIdRef = useRef(id);
  const wasPaneActiveRef = useRef(isPaneActive);
  const paneActiveAtRenderRef = useRef(isPaneActive);
  paneActiveAtRenderRef.current = isPaneActive;
  const entryReconciliationSerialRef = useRef(0);
  const [entryReconciliationRequest, setEntryReconciliationRequest] =
    useState<EntryReconciliationRequest | null>(null);
  const consumptionOperationTokensRef = useRef(new Map<string, symbol>());

  // Focus continuity: when an action removes the focused row, move focus to the
  // next visible row, else the previous, else the "Sort by" select.
  const listRegionRef = useRef<HTMLDivElement | null>(null);
  const sortSelectRef = useRef<HTMLSelectElement | null>(null);
  const pendingFocusNeighborRef = useRef<string | null | undefined>(undefined);
  const pendingFocusRafRef = useRef(0);
  const captureFocusNeighbor = useCallback((removedKey: string) => {
    const region = listRegionRef.current;
    if (!region) {
      pendingFocusNeighborRef.current = null;
      return;
    }
    const rows = Array.from(
      region.querySelectorAll<HTMLElement>("[data-collection-row-id]"),
    );
    const index = rows.findIndex(
      (el) => el.dataset.collectionRowId === removedKey,
    );
    if (index === -1) {
      pendingFocusNeighborRef.current = undefined;
      return;
    }
    const neighbor = rows[index + 1] ?? rows[index - 1] ?? null;
    pendingFocusNeighborRef.current = neighbor?.dataset.collectionRowId ?? null;
  }, []);

  const patchMediaInViews = useCallback(
    (
      mediaId: string,
      patch: (media: LibraryMediaEntry) => LibraryMediaEntry,
    ) => {
      setEntries((current) =>
        current.map((entry) =>
          entry.kind === "media" && entry.media.id === mediaId
            ? { ...entry, media: patch(entry.media) }
            : entry,
        ),
      );
    },
    [],
  );
  const libraryResource = useResource<LibraryPaneResource, { id: string }>({
    descriptor: libraryResourceDescriptor,
    params: { id },
    load: (params, signal) =>
      paneResourceLoaders.library!.load(
        clientResourceFetcher(signal),
        params,
      ) as Promise<LibraryPaneResource>,
  });
  const currentLibrary = library?.id === id ? library : null;
  const isDefaultLibrary = currentLibrary?.isDefault === true;
  // Entry mutation (add content, reorder, remove) is hidden for system-protected
  // libraries (e.g. the Oracle Corpus), which report canEditEntries === false.
  const canEditEntries =
    currentLibrary?.role === "admin" &&
    currentLibrary.canEditEntries === true;
  // Explicit reorder gate: Default has server-defined ordering and no reorder
  // UX/endpoint support, independent of canEditEntries (which stays true for
  // Default's "Add content" capability).
  const canReorder = canEditEntries && !isDefaultLibrary;
  const loading =
    libraryResource.status === "loading" && currentLibrary === null;
  useSetPaneLabel(currentLibrary?.name ?? (loading ? null : "Library"));
  const connectionSummaries = useConnectionSummaries(
    entries.map((entry) =>
      entry.kind === "podcast"
        ? `podcast:${entry.podcast.id}`
        : `media:${entry.media.id}`,
    ),
  );

  // The single non-initial first-page seam: a canonical/all view seeds from the
  // bootstrap resource, any other view fetches page 1 from the entries endpoint.
  const viewFirstPageParams: LibraryEntriesResourceParams | null =
    view !== null && !isInitialView ? { id, view } : null;
  const viewFirstPagePath = viewFirstPageParams
    ? libraryEntriesResource.clientPath(viewFirstPageParams)
    : null;
  const viewFetch = useDebouncedFetch<LibraryEntryPage>(
    viewFirstPagePath,
    async (signal) => {
      if (viewFirstPagePath === null) {
        // justify-defect: a non-null key is only built from a non-null path.
        throw new Error("Library view first-page fetch lost its path");
      }
      return decodeLibraryEntryPage(
        await apiFetch<LibraryEntryPageWire>(viewFirstPagePath, { signal }),
      );
    },
  );

  const [settingsOpen, setSettingsOpen] = useState(false);

  const entryLoadMoreAbortRef = useRef<AbortController | null>(null);
  const entryLoadMoreGenerationRef = useRef(0);
  const cancelEntryLoadMore = useCallback(() => {
    entryLoadMoreGenerationRef.current += 1;
    entryLoadMoreAbortRef.current?.abort();
    entryLoadMoreAbortRef.current = null;
    setLoadingMore(false);
  }, []);
  useEffect(() => () => entryLoadMoreAbortRef.current?.abort(), []);
  useEffect(() => {
    cancelEntryLoadMore();
    consumptionOperationTokensRef.current.clear();
  }, [cancelEntryLoadMore, id]);

  const { clear: clearRemovedEntryIds } = removedEntryIds;
  const requestEntryReconciliation = useCallback(
    (requestedView: LibraryEntryView) => {
      const serial = entryReconciliationSerialRef.current + 1;
      entryReconciliationSerialRef.current = serial;
      setEntryReconciliationRequest({
        ownerId: id,
        view: requestedView,
        serial,
      });
    },
    [id],
  );
  const entryReconciliationParams: LibraryEntriesResourceParams | null =
    entryReconciliationRequest
      ? {
          id: entryReconciliationRequest.ownerId,
          view: entryReconciliationRequest.view,
        }
      : null;
  const entryReconciliationPath = entryReconciliationParams
    ? libraryEntriesResource.clientPath(entryReconciliationParams)
    : null;
  const entryReconciliationFetch = useDebouncedFetch<EntryReconciliationResult>(
    entryReconciliationParams && entryReconciliationRequest
      ? `${libraryEntriesResource.cacheKey(entryReconciliationParams)}:reconcile:${entryReconciliationRequest.serial}`
      : null,
    async (signal) => {
      const request = entryReconciliationRequest;
      const path = entryReconciliationPath;
      if (request === null || path === null) {
        // justify-defect: a non-null reconciliation query key is constructed
        // from the same request/path pair consumed by this query function.
        throw new Error("Library entry reconciliation lost its query identity");
      }
      return {
        request,
        page: decodeLibraryEntryPage(
          await apiFetch<LibraryEntryPageWire>(path, { signal }),
        ),
      };
    },
    { debounceMs: 0 },
  );

  useEffect(() => {
    const result = entryReconciliationFetch.data;
    const request = entryReconciliationRequest;
    if (
      result === null ||
      request === null ||
      request.ownerId !== id ||
      result.request.ownerId !== request.ownerId ||
      result.request.serial !== request.serial
    ) {
      return;
    }
    cancelEntryLoadMore();
    clearRemovedEntryIds();
    setEntries(result.page.data);
    setEntryCursor(result.page.page.next_cursor);
    setLoadMoreError(null);
    libraryEntriesStaleRef.current = false;
    setEntryReconciliationRequest(null);
  }, [
    cancelEntryLoadMore,
    clearRemovedEntryIds,
    entryReconciliationFetch.data,
    entryReconciliationRequest,
    id,
  ]);

  useEffect(() => {
    if (entryReconciliationOwnerIdRef.current !== id) return;
    const becameActive = isPaneActive && !wasPaneActiveRef.current;
    wasPaneActiveRef.current = isPaneActive;
    if (becameActive && libraryEntriesStaleRef.current && view !== null) {
      requestEntryReconciliation(view);
    }
  }, [id, isPaneActive, requestEntryReconciliation, view]);

  useEffect(() => {
    entryReconciliationOwnerIdRef.current = id;
    entryReconciliationSerialRef.current += 1;
    libraryEntriesStaleRef.current = false;
    wasPaneActiveRef.current = paneActiveAtRenderRef.current;
    setEntryReconciliationRequest(null);
  }, [id]);

  // Library identity + error ownership. First-page entry seeding is owned by the
  // view effect below, not here, so appended pages survive resource re-reads.
  useEffect(() => {
    if (libraryResource.status === "ready") {
      setLibrary(libraryResource.data.library);
      setError(null);
      return;
    }

    if (libraryResource.status === "error") {
      cancelEntryLoadMore();
      if (
        isApiError(libraryResource.error) &&
        libraryResource.error.status === 404
      ) {
        router.push("/libraries");
        return;
      }
      setError(
        toFeedback(libraryResource.error, {
          fallback: "Failed to load library",
        }),
      );
      setLibrary((current) => (current?.id === id ? null : current));
      setEntries([]);
      setEntryCursor(null);
      setLoadMoreError(null);
    }
  }, [cancelEntryLoadMore, id, libraryResource, router]);

  // The single controller keyed by the view: reset on any view change, then seed
  // page 1 from the bootstrap resource (canonical/all) or clear until the view
  // fetch delivers page 1 (factual order or unfinished filter).
  useEffect(() => {
    if (view === null) return;
    cancelEntryLoadMore();
    clearRemovedEntryIds();
    setLoadMoreError(null);
    setViewInvalid(false);
    libraryEntriesStaleRef.current = false;
    // A reconciliation is bound to the view it was requested under; the fresh
    // page-1 load below supersedes it, so drop any pending/in-flight one (and
    // bump the serial) rather than let a stale view's rows/cursor land here.
    entryReconciliationSerialRef.current += 1;
    setEntryReconciliationRequest(null);
    if (isInitialView) {
      if (libraryResource.status === "ready") {
        setEntries(libraryResource.data.entries);
        setEntryCursor(libraryResource.data.entriesPage.next_cursor);
      } else {
        setEntries([]);
        setEntryCursor(null);
      }
      return;
    }
    setEntries([]);
    setEntryCursor(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    viewSignature,
    isInitialView,
    libraryResource,
    id,
    cancelEntryLoadMore,
    clearRemovedEntryIds,
  ]);

  // Apply the non-initial view's first page once it lands.
  useEffect(() => {
    if (isInitialView || viewFetch.data === null) return;
    cancelEntryLoadMore();
    clearRemovedEntryIds();
    setEntries(viewFetch.data.data);
    setEntryCursor(viewFetch.data.page.next_cursor);
    setLoadMoreError(null);
    setViewInvalid(false);
    libraryEntriesStaleRef.current = false;
  }, [
    isInitialView,
    viewFetch.data,
    cancelEntryLoadMore,
    clearRemovedEntryIds,
  ]);

  // A rejected (invalid) view fetch is terminal until the view changes.
  useEffect(() => {
    if (!isInitialView && isInvalidViewError(viewFetch.error)) {
      setViewInvalid(true);
    }
  }, [isInitialView, viewFetch.error]);

  const acceptSlateTarget = useCallback<ReadingSlateAccept>(
    (target, options) => {
      const targetId = slateTargetId(target);
      const frozenAttempt = () =>
        target.kind === "Podcast"
          ? addPodcastToLibrary(targetId, id)
          : ensureMediaInLibraries({
              mediaId: targetId,
              libraryIds: [id],
            });

      return new Promise((resolve) => {
        let observing = true;
        let inFlight = false;
        const abandon = () => {
          if (!observing) return;
          observing = false;
          resolve({ kind: "Abandoned" });
        };
        const runAttempt = () => {
          if (!observing || inFlight) return;
          inFlight = true;
          void frozenAttempt().then(
            () => {
              inFlight = false;
              if (!observing) return;
              observing = false;
              options.signal.removeEventListener("abort", abandon);
              libraryEntriesStaleRef.current = true;
              feedback.show({
                severity: "success",
                title: `Added to ${currentLibrary?.name ?? "library"}`,
              });
              resolve({ kind: "Accepted" });
            },
            (error: unknown) => {
              inFlight = false;
              if (!observing) return;
              if (handleUnauthenticatedApiError(error)) {
                observing = false;
                options.signal.removeEventListener("abort", abandon);
                resolve({ kind: "Abandoned" });
                return;
              }
              const apiError = toLibraryAddError(error);
              if (apiError.status >= 400 && apiError.status < 500) {
                observing = false;
                options.signal.removeEventListener("abort", abandon);
                resolve({ kind: "Rejected", error: apiError });
                return;
              }
              options.onUnknown({
                error: apiError,
                recovery: { kind: "Local", retry: runAttempt },
              });
            },
          );
        };

        if (options.signal.aborted) {
          abandon();
          return;
        }
        options.signal.addEventListener("abort", abandon, { once: true });
        runAttempt();
      });
    },
    [currentLibrary?.name, feedback, id],
  );

  const runMediaProcessingMutation = useCallback(
    async (args: {
      mediaId: string;
      busySet: StringIdSet;
      action: "retry" | "refresh";
      successTitle: string;
      errorFallback: string;
    }) => {
      if (args.busySet.ids.has(args.mediaId)) return;
      args.busySet.add(args.mediaId);
      try {
        const projection = await runSourceProcessingAction({
          mediaId: args.mediaId,
          action: args.action,
          successTitle: args.successTitle,
        });
        patchMediaInViews(args.mediaId, (media) => ({
          ...media,
          processing_status: projection.processingStatus,
          capabilities: {
            ...media.capabilities,
            ...projection.capabilityPatch,
          },
        }));
        feedback.show(projection.feedback);
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        feedback.show({
          ...toFeedback(err, { fallback: args.errorFallback }),
        });
      } finally {
        args.busySet.remove(args.mediaId);
      }
    },
    [feedback, patchMediaInViews],
  );

  const handleRetryProcessing = useCallback(
    (mediaId: string) =>
      runMediaProcessingMutation({
        mediaId,
        busySet: retryingMediaIds,
        action: "retry",
        successTitle: "Processing retry started.",
        errorFallback: "Failed to retry processing",
      }),
    [retryingMediaIds, runMediaProcessingMutation],
  );

  const handleRefreshSource = useCallback(
    (mediaId: string) =>
      runMediaProcessingMutation({
        mediaId,
        busySet: refreshingMediaIds,
        action: "refresh",
        successTitle: "Source refresh started.",
        errorFallback: "Failed to refresh source",
      }),
    [refreshingMediaIds, runMediaProcessingMutation],
  );

  const handleDeleteMedia = useCallback(
    async (entry: LibraryMediaListEntry) => {
      if (
        !confirm(
          `Delete "${entry.media.title}" from My Library and libraries you manage? This cannot be undone.`,
        )
      ) {
        return;
      }

      try {
        const result = await deleteMedia(entry.media.id);
        // The row leaves the pane whether the media was removed, hidden, or is
        // still being deleted server-side.
        setEntries((current) =>
          current.filter(
            (candidate) =>
              candidate.kind !== "media" ||
              candidate.media.id !== entry.media.id,
          ),
        );
        if (result.kind === "Deleting") {
          feedback.show({
            severity: "info",
            title: "Deleting from your library",
          });
        }
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        feedback.show({
          ...toFeedback(err, {
            fallback: "Failed to remove media",
          }),
        });
      }
    },
    [feedback],
  );

  const handleSetConsumption = useCallback(
    async (mediaId: string, status: "finished" | "unread") => {
      const previous = new Map<string, LibraryMediaConsumption>();
      for (const entry of entries) {
        if (entry.kind === "media" && entry.media.id === mediaId) {
          previous.set(entry.id, {
            read_state: entry.media.read_state,
            progress_fraction: entry.media.progress_fraction,
          });
        }
      }
      if (previous.size === 0) {
        throw new Error(`Library media ${mediaId} is not present`);
      }
      const operationToken = Symbol(mediaId);
      consumptionOperationTokensRef.current.set(mediaId, operationToken);
      patchMediaInViews(mediaId, (media) => ({
        ...media,
        read_state: status,
      }));

      try {
        if (status === "finished") {
          await lectern.ensureMediaFinished(parseMediaId(mediaId));
        } else {
          await lectern.setUnread(parseMediaId(mediaId));
        }
      } catch (err) {
        if (
          consumptionOperationTokensRef.current.get(mediaId) !== operationToken
        ) {
          return;
        }
        setEntries((current) =>
          current.map((entry) => {
            const fields = previous.get(entry.id);
            return entry.kind === "media" &&
              entry.media.id === mediaId &&
              fields
              ? { ...entry, media: { ...entry.media, ...fields } }
              : entry;
          }),
        );
        if (handleUnauthenticatedApiError(err)) return;
        feedback.show({
          ...toFeedback(err, { fallback: "Failed to update read state" }),
        });
      } finally {
        if (
          consumptionOperationTokensRef.current.get(mediaId) === operationToken
        ) {
          consumptionOperationTokensRef.current.delete(mediaId);
        }
      }
    },
    [entries, feedback, lectern, patchMediaInViews],
  );

  const handleAddToLectern = useCallback(
    async (mediaId: string) => {
      try {
        await lectern.placeItems({
          mediaIds: [parseMediaId(mediaId)],
          placement: { kind: "Last" },
        });
        feedback.show({ severity: "success", title: "Added to Lectern" });
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        feedback.show({
          ...toFeedback(err, { fallback: "Failed to add to Lectern" }),
        });
      }
    },
    [feedback, lectern],
  );

  const handleDeleteLibrary = async () => {
    if (!currentLibrary || currentLibrary.isDefault) {
      return;
    }
    if (!confirm(`Delete "${currentLibrary.name}"? This cannot be undone.`)) {
      return;
    }

    try {
      await apiFetch(`/api/libraries/${currentLibrary.id}`, {
        method: "DELETE",
      });
      router.push("/libraries");
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      if (isApiError(err)) {
        setError(
          toFeedback(err, {
            fallback: "Failed to delete library",
          }),
        );
      } else {
        setError({ severity: "error", title: "Failed to delete library" });
      }
    }
  };

  const handleRename = useCallback(
    async (name: string) => {
      if (!currentLibrary) return;
      await apiFetch(`/api/libraries/${currentLibrary.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      setLibrary({ ...currentLibrary, name });
    },
    [currentLibrary],
  );

  const handleDeleteFromSettings = useCallback(async () => {
    if (!currentLibrary) return;
    await apiFetch(`/api/libraries/${currentLibrary.id}`, {
      method: "DELETE",
    });
    setSettingsOpen(false);
    router.push("/libraries");
  }, [currentLibrary, router]);

  const handleOpenMediaChat = useCallback(
    async (media: LibraryMediaEntry) => {
      try {
        const conversationId = await startResourceContextChat(`media:${media.id}`);
        openInNewPane?.(`/conversations/${conversationId}`, media.title);
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        setError(
          toFeedback(err, {
            fallback: "Failed to open media chat",
          }),
        );
      }
    },
    [openInNewPane],
  );

  const handleLoadMoreEntries = useCallback(() => {
    if (entryCursor === null || loadingMore || view === null) {
      return;
    }
    entryLoadMoreAbortRef.current?.abort();
    const generation = entryLoadMoreGenerationRef.current + 1;
    entryLoadMoreGenerationRef.current = generation;
    const controller = new AbortController();
    entryLoadMoreAbortRef.current = controller;
    setLoadingMore(true);
    setLoadMoreError(null);
    void apiFetch<LibraryEntryPageWire>(
      libraryEntriesResource.clientPath({ id, view, cursor: entryCursor }),
      { signal: controller.signal },
    )
      .then(decodeLibraryEntryPage)
      .then((page) => {
        if (
          controller.signal.aborted ||
          generation !== entryLoadMoreGenerationRef.current
        ) {
          return;
        }
        setEntries((current) =>
          appendUniqueEntries(current, page.data, (entry) =>
            libraryRowKey(entry, isDefaultLibrary),
          ),
        );
        setEntryCursor(page.page.next_cursor);
      })
      .catch((err: unknown) => {
        if (
          isAbortError(err) ||
          controller.signal.aborted ||
          generation !== entryLoadMoreGenerationRef.current
        ) {
          return;
        }
        if (handleUnauthenticatedApiError(err)) return;
        if (isInvalidViewError(err)) {
          setViewInvalid(true);
          return;
        }
        setLoadMoreError(
          toFeedback(err, { fallback: "Failed to load more entries" }),
        );
      })
      .finally(() => {
        if (
          controller.signal.aborted ||
          generation !== entryLoadMoreGenerationRef.current
        ) {
          return;
        }
        setLoadingMore(false);
      });
  }, [entryCursor, id, isDefaultLibrary, loadingMore, view]);

  const handleReorderEntries = (nextEntries: LibraryEntry[]) => {
    if (!canReorder || entryCursor !== null) {
      return;
    }
    const previousEntries = entries;
    setEntries(nextEntries);
    setReorderBusy(true);
    setError(null);
    void apiFetch(`/api/libraries/${id}/entries/reorder`, {
      method: "PATCH",
      body: JSON.stringify({ entry_ids: nextEntries.map((entry) => entry.id) }),
    })
      .catch((err: unknown) => {
        setEntries(previousEntries);
        if (handleUnauthenticatedApiError(err)) return;
        if (isApiError(err)) {
          setError(
            toFeedback(err, {
              fallback: "Failed to reorder library entries",
            }),
          );
          return;
        }
        setError({
          severity: "error",
          title: "Failed to reorder library entries",
        });
      })
      .finally(() => {
        setReorderBusy(false);
      });
  };

  const paneOptions: ActionDescriptor[] = currentLibrary
    ? [
        ...(canEditEntries
          ? [
              {
                kind: "command" as const,
                id: "add-content",
                label: "Add content",
                restoreFocusOnClose: false,
                onSelect: () =>
                  dispatchOpenLauncher({
                    kind: "Add",
                    seed: {
                      kind: "Content",
                      initialFocus: "Url",
                      initialDestinations: currentLibrary.isDefault
                        ? []
                        : [
                            {
                              id: currentLibrary.id,
                              name: currentLibrary.name,
                              color: currentLibrary.color,
                            },
                          ],
                    },
                  }),
              },
            ]
          : []),
        ...libraryResourceOptions({
          library: currentLibrary,
          onOpenSettings: () => setSettingsOpen(true),
          onDelete: () => {
            void handleDeleteLibrary();
          },
        }),
      ]
    : [];

  const hideFinished = view?.completion === "unfinished";
  // Under the unfinished filter the client also drops a row the moment it is
  // marked finished, so Mark Finished visibly removes it from the filtered view.
  const isVisibleEntry = useCallback(
    (entry: LibraryEntry): boolean => {
      if (removedEntryIds.ids.has(entry.id)) return false;
      if (
        hideFinished &&
        entry.kind === "media" &&
        entry.media.read_state === "finished"
      ) {
        return false;
      }
      return true;
    },
    [hideFinished, removedEntryIds.ids],
  );
  const visibleEntries = entries.filter(isVisibleEntry);
  const entryFolioCount = visibleEntries.length;
  // Client-side filtering (hide finished, optimistic removal) can empty the
  // visible page while more entries remain server-side. Advance until an
  // eligible row appears or the cursor is exhausted, so the empty notice never
  // lies and a real next page is never stranded behind a hidden footer (AC3/AC8).
  useEffect(() => {
    if (
      view !== null &&
      entryCursor !== null &&
      visibleEntries.length === 0 &&
      !loadingMore &&
      loadMoreError === null
    ) {
      handleLoadMoreEntries();
    }
  }, [
    view,
    entryCursor,
    visibleEntries.length,
    loadingMore,
    loadMoreError,
    handleLoadMoreEntries,
  ]);
  const openConnectionRoute = useCallback(
    (
      href: string,
      inNewPane: boolean,
      secondaryActivation?: WorkspaceSecondaryActivation,
    ) => {
      if (inNewPane) openInNewPane?.(href, undefined, secondaryActivation);
      else router.push(href);
    },
    [openInNewPane, router],
  );
  const connectionsComposerController = useConnectionsComposerController({
    scheme: "library",
    id,
  });
  const connectionsBody = useMemo(
    () => (
      <ConnectionsSurface
        resourceRef={{ scheme: "library", id }}
        composerController={connectionsComposerController}
        onOpenRoute={openConnectionRoute}
      />
    ),
    [connectionsComposerController, id, openConnectionRoute],
  );
  const { companionAction } = useResourceInspector({
    scheme: "library",
    handle: id,
    bodies: { linkedItems: connectionsBody },
  });
  usePanePrimaryChrome({
    actions: companionAction ? [companionAction] : [],
    options: paneOptions,
    header: {
      kind: "section",
      folio: { kind: "count", value: entryFolioCount, unit: "entry" },
      pending: loading,
    },
  });

  const visibleRowSignature = visibleEntries
    .map((entry) => libraryRowKey(entry, isDefaultLibrary))
    .join("");
  useEffect(() => {
    const neighborKey = pendingFocusNeighborRef.current;
    if (neighborKey === undefined) return;
    pendingFocusNeighborRef.current = undefined;
    const moveFocus = () => {
      const region = listRegionRef.current;
      const focusInRow = (key: string): boolean => {
        const rowEl = region?.querySelector<HTMLElement>(
          `[data-collection-row-id="${CSS.escape(key)}"]`,
        );
        const focusable = rowEl?.querySelector<HTMLElement>(
          'a, button, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable) {
          focusable.focus();
          return true;
        }
        return false;
      };
      if (neighborKey !== null && focusInRow(neighborKey)) return;
      sortSelectRef.current?.focus();
    };
    // Defer past the menu's own focus-restore and the row-removal reflow so the
    // sibling (not the vanished trigger) ends up focused.
    const outer = requestAnimationFrame(() => {
      const inner = requestAnimationFrame(moveFocus);
      pendingFocusRafRef.current = inner;
    });
    pendingFocusRafRef.current = outer;
    return () => cancelAnimationFrame(pendingFocusRafRef.current);
  }, [visibleRowSignature]);

  if (loading) {
    return <PaneLoadingState />;
  }

  if (!currentLibrary) {
    return (
      <FeedbackNotice
        {...(error ?? { severity: "error", title: "Library not found" })}
      />
    );
  }

  const invalidView = decodedView.kind === "Invalid" || viewInvalid;
  const canReorderVisibleEntries =
    canReorder &&
    view !== null &&
    view.order.kind === "Canonical" &&
    view.completion === "all" &&
    entryCursor === null;
  const entryFooter = (
    <>
      {loadMoreError ? <FeedbackNotice {...loadMoreError} /> : null}
      <LoadMoreFooter
        hasMore={entryCursor !== null}
        loading={loadingMore}
        onLoadMore={handleLoadMoreEntries}
        label="Load more entries"
      />
    </>
  );
  const entryReconciliationNotice = entryReconciliationRequest ? (
    entryReconciliationFetch.error === null ? (
      <FeedbackNotice severity="neutral" title="Refreshing library entries…" />
    ) : (
      <FeedbackNotice
        feedback={toFeedback(
          toLibraryAddError(entryReconciliationFetch.error),
          {
            fallback: "Failed to refresh library entries",
          },
        )}
      >
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            requestEntryReconciliation(entryReconciliationRequest.view)
          }
        >
          Retry
        </Button>
      </FeedbackNotice>
    )
  ) : null;

  const addedContext = (entry: LibraryEntry): Presence<CollectionContext> => {
    const iso =
      isDefaultLibrary && entry.kind === "media"
        ? entry.media.created_at
        : entry.created_at;
    const label = isDefaultLibrary ? "Added to Nexus " : "Added ";
    return present({ kind: "Text", text: `${label}${formatAdded(iso)}` });
  };

  const entryRowView = (item: LibraryEntry): CollectionRowView => {
    const showAdded = view?.order.kind === "Added";
    if (item.kind === "podcast") {
      const row = presentPodcast(
        {
          id: item.podcast.id,
          title: item.podcast.title,
          contributors: item.podcast.contributors,
          unplayedCount: item.podcast.unplayedCount,
          publicationDate: item.podcast.publicationDate,
          syncStatus: item.podcast.syncStatus,
        },
        {
          canUsePodcastActions: canEditEntries,
          connectionSummary: connectionSummaries.get(
            `podcast:${item.podcast.id}`,
          ),
          onShare: ({ triggerEl }) =>
            openShare(
              resourceShareTarget(`podcast:${item.podcast.id}`),
              paneShareOpenOptions(triggerEl, paneId),
            ),
        },
      );
      return {
        ...row,
        id: item.id,
        context: showAdded ? addedContext(item) : row.context,
      };
    }
    const row = presentMedia(item.media, {
      readingTimeEstimate: item.readingTimeEstimate,
      connectionSummary: connectionSummaries.get(`media:${item.media.id}`),
      retryBusy: retryingMediaIds.ids.has(item.media.id),
      refreshBusy: refreshingMediaIds.ids.has(item.media.id),
      onRetry:
        canEditEntries && item.media.capabilities.can_retry
          ? () => {
              void handleRetryProcessing(item.media.id);
            }
          : undefined,
      onRefreshSource:
        canEditEntries && item.media.capabilities.can_refresh_source
          ? () => {
              void handleRefreshSource(item.media.id);
            }
          : undefined,
      onOpenChat: () => {
        void handleOpenMediaChat(item.media);
      },
      onShare: ({ triggerEl }) =>
        openShare(
          resourceShareTarget(`media:${item.media.id}`),
          paneShareOpenOptions(triggerEl, paneId),
        ),
      onDelete:
        canEditEntries && item.media.capabilities.can_delete
          ? () => {
              void handleDeleteMedia(item);
            }
          : undefined,
      onMarkFinished: () => {
        if (hideFinished) {
          captureFocusNeighbor(libraryRowKey(item, isDefaultLibrary));
        }
        void handleSetConsumption(item.media.id, "finished");
      },
      onMarkUnread: () => {
        void handleSetConsumption(item.media.id, "unread");
      },
      onAddToLectern: () => {
        void handleAddToLectern(item.media.id);
      },
    });
    return {
      ...row,
      id: libraryRowKey(item, isDefaultLibrary),
      context: showAdded ? addedContext(item) : row.context,
    };
  };
  const visibleEntryRows = visibleEntries.map(entryRowView);

  const orderPresetIds = orderPresetIdsFor(isDefaultLibrary);
  const toolbar =
    invalidView || view === null ? undefined : (
      <PaneToolbar
        filters={
          <>
            <label className={styles.selectField}>
              <span>Sort by</span>
              <Select
                ref={sortSelectRef}
                value={orderToPresetId(view.order)}
                onChange={(event) =>
                  setView({
                    order: presetIdToOrder(
                      event.target.value as LibraryOrderPresetId,
                    ),
                    completion: view.completion,
                  })
                }
              >
                {orderPresetIds.map((presetId) => (
                  <option key={presetId} value={presetId}>
                    {presetLabel(presetId, isDefaultLibrary)}
                  </option>
                ))}
              </Select>
            </label>
            <Toggle
              checked={hideFinished}
              onCheckedChange={(checked) =>
                setView({
                  order: view.order,
                  completion: checked ? "unfinished" : "all",
                })
              }
              label="Hide finished"
            />
          </>
        }
      />
    );

  const mainBody = invalidView ? (
    <FeedbackNotice severity="error" title="Invalid library view">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setDecodedView({ kind: "Valid", view: CANONICAL_VIEW })}
      >
        Reset view
      </Button>
    </FeedbackNotice>
  ) : visibleEntries.length > 0 ? (
    <CollectionView
      rows={visibleEntryRows}
      status="ready"
      ariaLabel="Library entries"
      footer={entryFooter}
      surface={false}
      sortable={
        canReorderVisibleEntries
          ? {
              disabled: reorderBusy,
              onReorder: (nextRows) => {
                const byEntryId = new Map(
                  visibleEntries.map((entry) => [entry.id, entry]),
                );
                const nextEntries = nextRows
                  .map((row) => byEntryId.get(row.id))
                  .filter(
                    (entry): entry is LibraryEntry => entry !== undefined,
                  );
                if (nextEntries.length === visibleEntries.length) {
                  handleReorderEntries(nextEntries);
                }
              },
            }
          : undefined
      }
    />
  ) : !isInitialView && viewFetch.loading ? (
    <PaneLoadingState />
  ) : !isInitialView && viewFetch.error !== null ? (
    <FeedbackNotice
      feedback={toFeedback(viewFetch.error, {
        fallback: "Failed to load library entries",
      })}
    />
  ) : entryCursor !== null ? (
    // Empty after filtering but more pages remain: the auto-advance effect is
    // fetching them; surface its progress/error instead of a false empty state.
    entryFooter
  ) : hideFinished ? (
    <FeedbackNotice severity="neutral" title="No unfinished items">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setView({ order: view!.order, completion: "all" })}
      >
        Show finished
      </Button>
    </FeedbackNotice>
  ) : (
    <FeedbackNotice
      severity="neutral"
      title="No podcasts or media in this library yet."
    />
  );

  return (
    <>
      <PaneSurface
        opener={<SectionOpener heading={currentLibrary.name} scale="title" />}
        toolbar={toolbar}
        state={
          error || entryReconciliationNotice ? (
            <>
              {error ? <FeedbackNotice {...error} /> : null}
              {entryReconciliationNotice}
            </>
          ) : null
        }
      >
        <div ref={listRegionRef}>{mainBody}</div>
        <ReadingSlateSection
          destination={{
            kind: "Library",
            id: currentLibrary.id,
            name: currentLibrary.name,
          }}
          paneId={paneId}
          isActive={isPaneActive}
          accept={acceptSlateTarget}
        />
      </PaneSurface>

      {settingsOpen ? (
        <LibrarySettingsDialog
          open
          onClose={() => setSettingsOpen(false)}
          library={{
            id: currentLibrary.id,
            name: currentLibrary.name,
            canRename: currentLibrary.canRename,
            canDelete: currentLibrary.canDelete,
          }}
          onRename={handleRename}
          onDelete={handleDeleteFromSettings}
        />
      ) : null}
    </>
  );
}
