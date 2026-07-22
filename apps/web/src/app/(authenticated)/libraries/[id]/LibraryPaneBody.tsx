"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { dispatchOpenLauncher } from "@/lib/launcher/launcherEvents";
import { ApiError, apiFetch, isApiError } from "@/lib/api/client";
import type { Presence } from "@/lib/api/presence";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  libraryEntriesResource,
  libraryResource as libraryResourceDescriptor,
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
import { libraryResourceOptions } from "@/lib/actions/resourceActions";
import { useLectern } from "@/lib/lectern/LecternProvider";
import { parseMediaId } from "@/lib/lectern/contract";
import { presentMedia } from "@/lib/collections/presenters/media";
import { presentPodcast } from "@/lib/collections/presenters/podcast";
import { startResourceChat } from "@/lib/resources/resourceChat";
import LibraryMembershipPanel from "@/components/LibraryMembershipPanel";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import {
  ensureMediaAbsentFromLibrary,
  ensureMediaInLibraries,
  fetchMediaLibraryMemberships,
  deleteMedia,
  patchLibraryMembership,
} from "@/lib/media/mediaLibraries";
import { useStringIdSet, type StringIdSet } from "@/lib/useStringIdSet";
import { clientResourceFetcher } from "@/lib/api/resourceTransport.client";
import { useResource } from "@/lib/api/useResource";
import { paneResourceLoaders } from "@/lib/panes/paneResourceLoaders";
import {
  addPodcastToLibrary,
  fetchPodcastLibraries,
  removePodcastFromLibrary,
} from "@/app/(authenticated)/podcasts/podcastSubscriptions";
import LibraryBrief from "@/components/library/LibraryBrief";
import Button from "@/components/ui/Button";
import PaneSurface from "@/components/ui/PaneSurface";
import SectionOpener from "@/components/ui/SectionOpener";
import CollectionView from "@/components/collections/CollectionView";
import ReadingSlateSection from "@/components/collections/ReadingSlateSection";
import PaneToolbar from "@/components/ui/PaneToolbar";
import SortSelect from "@/components/ui/SortSelect";
import type { CollectionRowView } from "@/lib/collections/types";
import type {
  PositiveCount,
  ProgressFraction,
} from "@/lib/consumption/activityFacts";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import type { PodcastSyncStatus } from "@/lib/status/podcastSync";
import { useConnectionSummaries } from "@/lib/collections/useConnectionSummaries";
import { useDebouncedFetch } from "@/lib/api/useDebouncedFetch";
import LibraryEditDialog from "@/components/LibraryEditDialog";
import {
  fetchEditableLibrarySharing,
  type LibraryInvite,
  type LibraryMember,
  type UserSearchResult,
} from "@/lib/libraries/sharing";
import type { LibraryTargetPickerItem } from "@/lib/media/mediaLibraries";
import type { LibraryForEdit } from "@/components/LibraryEditDialog";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import {
  usePaneParam,
  usePaneRouter,
  usePaneRuntime,
  usePaneSearchParams,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import type { ContributorCredit } from "@/lib/contributors/types";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { isAbortError } from "@/lib/errors";
import {
  decodeLibraryReadingTimeEntry,
  type LibraryMediaKind,
  type ReadingTimeEstimatePresence,
} from "@/lib/libraries/readingTime";
import { slateTargetId } from "@/lib/resonance/contract";
import type { ReadingSlateAccept } from "@/lib/resonance/useReadingSlate";

interface Library {
  id: string;
  name: string;
  color: string | null;
  is_default: boolean;
  role: string;
  owner_user_id: string;
  system_key: string | null;
  can_rename: boolean;
  can_delete: boolean;
  can_edit_entries: boolean;
}

interface LibraryMediaEntry {
  id: string;
  kind: LibraryMediaKind;
  title: string;
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

export default function LibraryPaneBody() {
  const id = usePaneParam("id");
  if (!id) {
    throw new Error("library route requires an id");
  }
  const router = usePaneRouter();
  const paneSearchParams = usePaneSearchParams();
  const paneRuntime = usePaneRuntime();
  const { openInNewPane } = paneRuntime ?? {};
  const isPaneActive = paneRuntime?.isActive ?? true;
  const paneId = paneRuntime?.paneId ?? `library-${id}`;
  const feedback = useFeedback();
  const lectern = useLectern();
  const [library, setLibrary] = useState<Library | null>(null);
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [entryCursor, setEntryCursor] = useState<string | null>(null);
  const [manualLoadingMore, setManualLoadingMore] = useState(false);
  const [manualLoadMoreError, setManualLoadMoreError] =
    useState<FeedbackContent | null>(null);
  const [resonanceEntries, setResonanceEntries] = useState<LibraryEntry[]>([]);
  const [resonanceCursor, setResonanceCursor] = useState<string | null>(null);
  const [resonanceLoadingMore, setResonanceLoadingMore] = useState(false);
  const [resonanceLoadMoreError, setResonanceLoadMoreError] =
    useState<FeedbackContent | null>(null);
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
  const entryReconciliationAbortRef = useRef<AbortController | null>(null);
  const entryReconciliationGenerationRef = useRef(0);
  const [entryReconciliation, setEntryReconciliation] = useState<
    | { kind: "Idle" }
    | { kind: "Loading"; sort: "manual" | "resonance" }
    | {
        kind: "Failed";
        sort: "manual" | "resonance";
        error: ApiError;
      }
  >({ kind: "Idle" });
  const consumptionOperationTokensRef = useRef(new Map<string, symbol>());
  const patchMediaInViews = useCallback(
    (
      mediaId: string,
      patch: (media: LibraryMediaEntry) => LibraryMediaEntry,
    ) => {
      const apply = (current: LibraryEntry[]) =>
        current.map((entry) =>
          entry.kind === "media" && entry.media.id === mediaId
            ? { ...entry, media: patch(entry.media) }
            : entry,
        );
      setEntries(apply);
      setResonanceEntries(apply);
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
  const isDefaultLibrary = currentLibrary?.is_default === true;
  // Default's read surface is a live, server-ordered virtual set: resonance is
  // rejected by the endpoint and the UI must never request or offer it, so a
  // stale/manually-crafted `?sort=resonance` is always forced back to manual.
  const sort =
    !isDefaultLibrary && paneSearchParams.get("sort") === "resonance"
      ? "resonance"
      : "manual";
  // Entry mutation (add content, reorder, remove) is hidden for system-protected
  // libraries (e.g. the Oracle Corpus), which report can_edit_entries === false.
  const canEditEntries =
    currentLibrary?.role === "admin" &&
    currentLibrary.can_edit_entries === true;
  // Explicit reorder gate: Default has server-defined ordering and no reorder
  // UX/endpoint support, independent of canEditEntries (which stays true for
  // Default's "Add content" capability).
  const canReorder = canEditEntries && !isDefaultLibrary;
  const loading =
    libraryResource.status === "loading" && currentLibrary === null;
  useSetPaneLabel(currentLibrary?.name ?? (loading ? null : "Library"));
  const connectionSummaryEntries =
    sort === "resonance" ? resonanceEntries : entries;
  const connectionSummaries = useConnectionSummaries(
    connectionSummaryEntries.map((entry) =>
      entry.kind === "podcast"
        ? `podcast:${entry.podcast.id}`
        : `media:${entry.media.id}`,
    ),
  );
  const setSort = useCallback(
    (next: "manual" | "resonance") => {
      const params = new URLSearchParams(paneSearchParams);
      if (next === "resonance") {
        params.set("sort", "resonance");
      } else {
        params.delete("sort");
      }
      const qs = params.toString();
      router.replace(qs ? `/libraries/${id}?${qs}` : `/libraries/${id}`, {
        viewTransition: { kind: "collection-reflow" },
      });
    },
    [id, paneSearchParams, router],
  );
  const resonanceEntriesPath = libraryEntriesResource.clientPath({
    id,
    sort: "resonance",
  });
  const resonanceFetch = useDebouncedFetch<LibraryEntryPage>(
    sort === "resonance" ? resonanceEntriesPath : null,
    async (signal) =>
      decodeLibraryEntryPage(
        await apiFetch<LibraryEntryPageWire>(resonanceEntriesPath, { signal }),
      ),
  );

  const [editOpen, setEditOpen] = useState(false);
  const [editMembers, setEditMembers] = useState<LibraryMember[]>([]);
  const [editInvites, setEditInvites] = useState<LibraryInvite[]>([]);
  const [libraryPanelEntry, setLibraryPanelEntry] =
    useState<LibraryEntry | null>(null);
  const [libraryPanelAnchorEl, setLibraryPanelAnchorEl] =
    useState<HTMLElement | null>(null);
  const [libraryPanelLibraries, setLibraryPanelLibraries] = useState<
    LibraryTargetPickerItem[]
  >([]);
  const [libraryPanelLoading, setLibraryPanelLoading] = useState(false);
  const [libraryPanelBusy, setLibraryPanelBusy] = useState(false);
  const [libraryPanelError, setLibraryPanelError] = useState<string | null>(
    null,
  );
  const libraryPanelRequestIdRef = useRef(0);

  const libraryPanelEntryIdRef = useRef<string | null>(null);

  const entryLoadMoreAbortRef = useRef<AbortController | null>(null);
  const entryLoadMoreGenerationRef = useRef(0);
  const cancelEntryLoadMore = useCallback(() => {
    entryLoadMoreGenerationRef.current += 1;
    entryLoadMoreAbortRef.current?.abort();
    entryLoadMoreAbortRef.current = null;
    setManualLoadingMore(false);
    setResonanceLoadingMore(false);
  }, []);
  useEffect(() => () => entryLoadMoreAbortRef.current?.abort(), []);
  useEffect(() => {
    cancelEntryLoadMore();
    consumptionOperationTokensRef.current.clear();
  }, [cancelEntryLoadMore, id]);

  const { clear: clearRemovedEntryIds } = removedEntryIds;
  const reconcileEntries = useCallback(
    (requestedSort: "manual" | "resonance") => {
      entryReconciliationAbortRef.current?.abort();
      const generation = entryReconciliationGenerationRef.current + 1;
      entryReconciliationGenerationRef.current = generation;
      const controller = new AbortController();
      entryReconciliationAbortRef.current = controller;
      setEntryReconciliation({ kind: "Loading", sort: requestedSort });
      const path = libraryEntriesResource.clientPath({
        id,
        sort: requestedSort === "resonance" ? "resonance" : undefined,
      });
      void apiFetch<LibraryEntryPageWire>(path, { signal: controller.signal })
        .then(decodeLibraryEntryPage)
        .then((page) => {
          if (
            controller.signal.aborted ||
            entryReconciliationGenerationRef.current !== generation
          ) {
            return;
          }
          cancelEntryLoadMore();
          clearRemovedEntryIds();
          if (requestedSort === "resonance") {
            setResonanceEntries(page.data);
            setResonanceCursor(page.page.next_cursor);
            setResonanceLoadMoreError(null);
          } else {
            setEntries(page.data);
            setEntryCursor(page.page.next_cursor);
            setManualLoadMoreError(null);
          }
          libraryEntriesStaleRef.current = false;
          entryReconciliationAbortRef.current = null;
          setEntryReconciliation({ kind: "Idle" });
        })
        .catch((error: unknown) => {
          if (
            controller.signal.aborted ||
            entryReconciliationGenerationRef.current !== generation ||
            isAbortError(error)
          ) {
            return;
          }
          if (handleUnauthenticatedApiError(error)) return;
          entryReconciliationAbortRef.current = null;
          setEntryReconciliation({
            kind: "Failed",
            sort: requestedSort,
            error: toLibraryAddError(error),
          });
        });
    },
    [cancelEntryLoadMore, clearRemovedEntryIds, id],
  );

  useEffect(() => {
    if (entryReconciliationOwnerIdRef.current !== id) return;
    const becameActive = isPaneActive && !wasPaneActiveRef.current;
    wasPaneActiveRef.current = isPaneActive;
    if (becameActive && libraryEntriesStaleRef.current) {
      reconcileEntries(sort);
    }
  }, [id, isPaneActive, reconcileEntries, sort]);

  useEffect(() => {
    entryReconciliationOwnerIdRef.current = id;
    entryReconciliationGenerationRef.current += 1;
    entryReconciliationAbortRef.current?.abort();
    entryReconciliationAbortRef.current = null;
    libraryEntriesStaleRef.current = false;
    wasPaneActiveRef.current = paneActiveAtRenderRef.current;
    setEntryReconciliation({ kind: "Idle" });
    return () => {
      entryReconciliationGenerationRef.current += 1;
      entryReconciliationAbortRef.current?.abort();
    };
  }, [id]);

  useEffect(() => {
    if (libraryResource.status === "ready") {
      cancelEntryLoadMore();
      setLibrary(libraryResource.data.library);
      setEntries(libraryResource.data.entries);
      setEntryCursor(libraryResource.data.entriesPage.next_cursor);
      setManualLoadingMore(false);
      setManualLoadMoreError(null);
      clearRemovedEntryIds();
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
      setManualLoadingMore(false);
      setManualLoadMoreError(null);
    }
  }, [cancelEntryLoadMore, clearRemovedEntryIds, id, libraryResource, router]);

  useEffect(() => {
    if (sort !== "resonance") {
      setResonanceEntries([]);
      setResonanceCursor(null);
      setResonanceLoadingMore(false);
      setResonanceLoadMoreError(null);
      return;
    }
    if (resonanceFetch.data === null) {
      return;
    }
    setResonanceEntries(resonanceFetch.data.data);
    setResonanceCursor(resonanceFetch.data.page.next_cursor);
    setResonanceLoadMoreError(null);
  }, [resonanceFetch.data, sort]);

  const closeLibraryPanel = useCallback(() => {
    libraryPanelRequestIdRef.current += 1;
    libraryPanelEntryIdRef.current = null;
    setLibraryPanelEntry(null);
    setLibraryPanelAnchorEl(null);
    setLibraryPanelLibraries([]);
    setLibraryPanelLoading(false);
    setLibraryPanelBusy(false);
    setLibraryPanelError(null);
  }, []);

  const openLibraryPanel = useCallback(
    async (entry: LibraryEntry, triggerEl: HTMLElement | null) => {
      const requestId = libraryPanelRequestIdRef.current + 1;
      libraryPanelRequestIdRef.current = requestId;
      libraryPanelEntryIdRef.current = entry.id;
      setLibraryPanelEntry(entry);
      setLibraryPanelAnchorEl(triggerEl);
      setLibraryPanelLibraries([]);
      setLibraryPanelLoading(true);
      setLibraryPanelBusy(false);
      setLibraryPanelError(null);

      try {
        const libraries =
          entry.kind === "podcast"
            ? await fetchPodcastLibraries(entry.podcast.id)
            : await fetchMediaLibraryMemberships(entry.media.id);
        if (libraryPanelRequestIdRef.current !== requestId) {
          return;
        }
        setLibraryPanelLibraries(libraries);
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        if (libraryPanelRequestIdRef.current !== requestId) {
          return;
        }
        setLibraryPanelError(
          toFeedback(err, { fallback: "Failed to load libraries" }).title,
        );
      } finally {
        if (libraryPanelRequestIdRef.current === requestId) {
          setLibraryPanelLoading(false);
        }
      }
    },
    [],
  );

  const handleAddToLibrary = useCallback(
    async (libraryId: string) => {
      if (!libraryPanelEntry || libraryPanelBusy) {
        return;
      }
      setLibraryPanelBusy(true);
      setLibraryPanelError(null);
      try {
        if (libraryPanelEntry.kind === "podcast") {
          await addPodcastToLibrary(libraryPanelEntry.podcast.id, libraryId);
        } else {
          await ensureMediaInLibraries({
            mediaId: libraryPanelEntry.media.id,
            libraryIds: [libraryId],
          });
        }

        if (libraryPanelEntryIdRef.current === libraryPanelEntry.id) {
          setLibraryPanelLibraries((current) =>
            patchLibraryMembership(current, libraryId, true),
          );
        }
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        setLibraryPanelError(
          toFeedback(err, { fallback: "Failed to add item to library" }).title,
        );
      } finally {
        setLibraryPanelBusy(false);
      }
    },
    [libraryPanelBusy, libraryPanelEntry],
  );

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

  const handleRemoveFromLibrary = useCallback(
    async (libraryId: string) => {
      if (!libraryPanelEntry || libraryPanelBusy) {
        return;
      }
      const entry = libraryPanelEntry;
      const removingCurrentEntry = libraryId === id;
      const previousEntries = entries;
      setLibraryPanelBusy(true);
      setLibraryPanelError(null);

      if (removingCurrentEntry) {
        removedEntryIds.add(entry.id);
        flushSync(() => {
          setEntries((current) =>
            current.filter((candidate) => {
              if (candidate.id === entry.id) {
                return false;
              }
              if (
                entry.kind === "media" &&
                candidate.kind === "media" &&
                candidate.media.id === entry.media.id
              ) {
                return false;
              }
              if (
                entry.kind === "podcast" &&
                candidate.kind === "podcast" &&
                candidate.podcast.id === entry.podcast.id
              ) {
                return false;
              }
              return true;
            }),
          );
        });
        closeLibraryPanel();
      }

      try {
        if (entry.kind === "podcast") {
          await removePodcastFromLibrary(entry.podcast.id, libraryId);
        } else {
          await ensureMediaAbsentFromLibrary({
            mediaId: entry.media.id,
            libraryId,
          });
        }

        if (removingCurrentEntry) {
          return;
        }

        if (libraryPanelEntryIdRef.current === entry.id) {
          setLibraryPanelLibraries((current) =>
            patchLibraryMembership(current, libraryId, false),
          );
        }
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        if (removingCurrentEntry) {
          setEntries(previousEntries);
          removedEntryIds.remove(entry.id);
        }
        setLibraryPanelError(
          toFeedback(err, { fallback: "Failed to remove item from library" })
            .title,
        );
      } finally {
        setLibraryPanelBusy(false);
      }
    },
    [
      closeLibraryPanel,
      entries,
      id,
      libraryPanelBusy,
      libraryPanelEntry,
      removedEntryIds,
    ],
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
            fallback: "Failed to delete document",
          }),
        });
      }
    },
    [feedback],
  );

  const handleSetConsumption = useCallback(
    async (mediaId: string, status: "finished" | "unread") => {
      const capture = (current: LibraryEntry[]) => {
        const previous = new Map<string, LibraryMediaConsumption>();
        for (const entry of current) {
          if (entry.kind === "media" && entry.media.id === mediaId) {
            previous.set(entry.id, {
              read_state: entry.media.read_state,
              progress_fraction: entry.media.progress_fraction,
            });
          }
        }
        return previous;
      };
      const previousEntries = capture(entries);
      const previousResonanceEntries = capture(resonanceEntries);
      if (previousEntries.size === 0 && previousResonanceEntries.size === 0) {
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
        const restore = (
          current: LibraryEntry[],
          previous: Map<string, LibraryMediaConsumption>,
        ) =>
          current.map((entry) => {
            const fields = previous.get(entry.id);
            return entry.kind === "media" &&
              entry.media.id === mediaId &&
              fields
              ? { ...entry, media: { ...entry.media, ...fields } }
              : entry;
          });
        setEntries((current) => restore(current, previousEntries));
        setResonanceEntries((current) =>
          restore(current, previousResonanceEntries),
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
    [entries, feedback, lectern, patchMediaInViews, resonanceEntries],
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
    if (!currentLibrary || currentLibrary.is_default) {
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

  const openEditDialog = useCallback(async () => {
    if (!currentLibrary) return;
    setEditOpen(true);
    try {
      const sharing = await fetchEditableLibrarySharing(currentLibrary);
      setEditMembers(sharing.members);
      setEditInvites(sharing.invites);
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      if (isApiError(err)) {
        setError(
          toFeedback(err, {
            fallback: "Failed to load library sharing",
          }),
        );
      }
    }
  }, [currentLibrary]);

  const closeEditDialog = useCallback(() => {
    setEditOpen(false);
    setEditMembers([]);
    setEditInvites([]);
  }, []);

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

  const handleUpdateMemberRole = useCallback(
    async (userId: string, role: string) => {
      if (!currentLibrary) return;
      await apiFetch(`/api/libraries/${currentLibrary.id}/members/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      setEditMembers((prev) =>
        prev.map((member) =>
          member.user_id === userId ? { ...member, role } : member,
        ),
      );
    },
    [currentLibrary],
  );

  const handleRemoveMember = useCallback(
    async (userId: string) => {
      if (!currentLibrary) return;
      await apiFetch(`/api/libraries/${currentLibrary.id}/members/${userId}`, {
        method: "DELETE",
      });
      setEditMembers((prev) =>
        prev.filter((member) => member.user_id !== userId),
      );
    },
    [currentLibrary],
  );

  const handleCreateInvite = useCallback(
    async (inviteeIdentifier: string, role: string) => {
      if (!currentLibrary) return;
      const isEmail = inviteeIdentifier.includes("@");
      const response = await apiFetch<{ data: LibraryInvite }>(
        `/api/libraries/${currentLibrary.id}/invites`,
        {
          method: "POST",
          body: JSON.stringify(
            isEmail
              ? { invitee_email: inviteeIdentifier, role }
              : { invitee_user_id: inviteeIdentifier, role },
          ),
        },
      );
      setEditInvites((prev) => [response.data, ...prev]);
    },
    [currentLibrary],
  );

  const handleSearchUsers = useCallback(
    async (query: string): Promise<UserSearchResult[]> => {
      const response = await apiFetch<{ data: UserSearchResult[] }>(
        `/api/users/search?q=${encodeURIComponent(query)}`,
      );
      return response.data;
    },
    [],
  );

  const handleRevokeInvite = useCallback(async (inviteId: string) => {
    await apiFetch(`/api/libraries/invites/${inviteId}`, {
      method: "DELETE",
    });
    setEditInvites((prev) =>
      prev.map((invite) =>
        invite.id === inviteId ? { ...invite, status: "revoked" } : invite,
      ),
    );
  }, []);

  const handleDeleteFromDialog = useCallback(async () => {
    if (!currentLibrary) return;
    if (!confirm(`Delete "${currentLibrary.name}"? This cannot be undone.`)) {
      return;
    }
    await apiFetch(`/api/libraries/${currentLibrary.id}`, {
      method: "DELETE",
    });
    closeEditDialog();
    router.push("/libraries");
  }, [currentLibrary, closeEditDialog, router]);

  const handleOpenMediaChat = useCallback(
    async (media: LibraryMediaEntry) => {
      try {
        const conversationId = await startResourceChat(`media:${media.id}`);
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

  const handleLoadMoreEntries = useCallback(
    (requestedSort: "manual" | "resonance") => {
      const cursor =
        requestedSort === "resonance" ? resonanceCursor : entryCursor;
      if (cursor === null) {
        return;
      }
      if (requestedSort === "resonance") {
        if (resonanceLoadingMore) return;
      } else {
        if (manualLoadingMore) return;
      }

      entryLoadMoreAbortRef.current?.abort();
      const generation = entryLoadMoreGenerationRef.current + 1;
      entryLoadMoreGenerationRef.current = generation;
      const controller = new AbortController();
      entryLoadMoreAbortRef.current = controller;
      setManualLoadingMore(requestedSort === "manual");
      setResonanceLoadingMore(requestedSort === "resonance");
      if (requestedSort === "resonance") {
        setResonanceLoadMoreError(null);
      } else {
        setManualLoadMoreError(null);
      }
      void apiFetch<LibraryEntryPageWire>(
        libraryEntriesResource.clientPath({
          id,
          cursor,
          sort: requestedSort === "resonance" ? "resonance" : undefined,
        }),
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
          if (requestedSort === "resonance") {
            setResonanceEntries((current) =>
              appendUniqueEntries(current, page.data),
            );
            setResonanceCursor(page.page.next_cursor);
          } else {
            setEntries((current) =>
              appendUniqueEntries(current, page.data, (entry) =>
                libraryRowKey(entry, isDefaultLibrary),
              ),
            );
            setEntryCursor(page.page.next_cursor);
          }
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
          const feedbackContent = toFeedback(err, {
            fallback:
              requestedSort === "resonance"
                ? "Failed to load more resonance entries"
                : "Failed to load more entries",
          });
          if (requestedSort === "resonance") {
            setResonanceLoadMoreError(feedbackContent);
          } else {
            setManualLoadMoreError(feedbackContent);
          }
        })
        .finally(() => {
          if (
            controller.signal.aborted ||
            generation !== entryLoadMoreGenerationRef.current
          ) {
            return;
          }
          if (requestedSort === "resonance") {
            setResonanceLoadingMore(false);
          } else {
            setManualLoadingMore(false);
          }
        });
    },
    [
      entryCursor,
      id,
      isDefaultLibrary,
      manualLoadingMore,
      resonanceCursor,
      resonanceLoadingMore,
    ],
  );

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
                      initialDestinations: currentLibrary.is_default
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
          onEdit: () => void openEditDialog(),
          onDelete: () => {
            void handleDeleteLibrary();
          },
        }),
      ]
    : [];

  const entryFolioCount = entries.filter(
    (entry) => !removedEntryIds.ids.has(entry.id),
  ).length;
  usePanePrimaryChrome({
    options: paneOptions,
    header: {
      kind: "section",
      folio: { kind: "count", value: entryFolioCount, unit: "entry" },
      pending: loading,
    },
  });

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

  const editLibraryForDialog: LibraryForEdit = {
    id: currentLibrary.id,
    name: currentLibrary.name,
    is_default: currentLibrary.is_default,
    role: currentLibrary.role,
    owner_user_id: currentLibrary.owner_user_id,
  };
  const visibleEntries = entries.filter(
    (entry) => !removedEntryIds.ids.has(entry.id),
  );
  const visibleResonanceEntries = resonanceEntries.filter(
    (entry) => !removedEntryIds.ids.has(entry.id),
  );
  const canReorderVisibleEntries =
    canReorder && sort === "manual" && entryCursor === null;
  const entryFooter =
    sort === "resonance" ? (
      <>
        {resonanceLoadMoreError ? (
          <FeedbackNotice {...resonanceLoadMoreError} />
        ) : null}
        <LoadMoreFooter
          hasMore={resonanceCursor !== null}
          loading={resonanceLoadingMore}
          onLoadMore={() => handleLoadMoreEntries("resonance")}
          label="Load more entries"
        />
      </>
    ) : (
      <>
        {manualLoadMoreError ? (
          <FeedbackNotice {...manualLoadMoreError} />
        ) : null}
        <LoadMoreFooter
          hasMore={entryCursor !== null}
          loading={manualLoadingMore}
          onLoadMore={() => handleLoadMoreEntries("manual")}
          label="Load more entries"
        />
      </>
    );
  const entryReconciliationNotice =
    entryReconciliation.kind === "Loading" ? (
      <FeedbackNotice severity="neutral" title="Refreshing library entries…" />
    ) : entryReconciliation.kind === "Failed" ? (
      <FeedbackNotice
        feedback={toFeedback(entryReconciliation.error, {
          fallback: "Failed to refresh library entries",
        })}
      >
        <Button
          variant="secondary"
          size="sm"
          onClick={() => reconcileEntries(entryReconciliation.sort)}
        >
          Retry
        </Button>
      </FeedbackNotice>
    ) : null;
  const resonanceStatus = resonanceFetch.loading
    ? "loading"
    : resonanceFetch.error !== null && resonanceEntries.length === 0
      ? "error"
      : "ready";

  const entryRowView = (item: LibraryEntry): CollectionRowView => {
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
          onManageLibraries: ({ triggerEl }) => {
            void openLibraryPanel(item, triggerEl);
          },
        },
      );
      return { ...row, id: item.id };
    }
    const row = presentMedia(item.media, {
      canManageLibraries: canEditEntries,
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
      onManageLibraries: canEditEntries
        ? ({ triggerEl }) => {
            void openLibraryPanel(item, triggerEl);
          }
        : undefined,
      onDelete:
        canEditEntries && item.media.capabilities.can_delete
          ? () => {
              void handleDeleteMedia(item);
            }
          : undefined,
      onMarkFinished: () => {
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
    };
  };
  const visibleEntryRows = visibleEntries.map(entryRowView);

  return (
    <>
      <LibraryMembershipPanel
        open={libraryPanelEntry !== null}
        title="Libraries"
        anchorEl={libraryPanelAnchorEl}
        libraries={libraryPanelLibraries}
        loading={libraryPanelLoading}
        busy={libraryPanelBusy}
        error={libraryPanelError}
        emptyMessage="No non-default libraries available."
        onClose={closeLibraryPanel}
        onAddToLibrary={(libraryId) => {
          void handleAddToLibrary(libraryId);
        }}
        onRemoveFromLibrary={(libraryId) => {
          void handleRemoveFromLibrary(libraryId);
        }}
      />
      <PaneSurface
        opener={<SectionOpener heading={currentLibrary.name} scale="title" />}
        brief={<LibraryBrief libraryId={id} />}
        toolbar={
          visibleEntries.length > 0 ? (
            <PaneToolbar
              controls={
                <>
                  {isDefaultLibrary ? null : (
                    <SortSelect
                      label="Sort"
                      value={sort}
                      options={[
                        { value: "manual", label: "Manual" },
                        { value: "resonance", label: "Resonance" },
                      ]}
                      onChange={(value) =>
                        setSort(value === "resonance" ? "resonance" : "manual")
                      }
                    />
                  )}
                </>
              }
            />
          ) : undefined
        }
        state={
          error || entryReconciliationNotice ? (
            <>
              {error ? <FeedbackNotice {...error} /> : null}
              {entryReconciliationNotice}
            </>
          ) : null
        }
      >
        {sort === "resonance" ? (
          <CollectionView
            rows={visibleResonanceEntries.map(entryRowView)}
            status={resonanceStatus}
            ariaLabel="Library by resonance"
            empty={
              <FeedbackNotice
                severity="neutral"
                title="No entries to rank yet."
              />
            }
            error={
              resonanceFetch.error ? (
                <FeedbackNotice
                  feedback={toFeedback(resonanceFetch.error, {
                    fallback: "Failed to rank library entries",
                  })}
                />
              ) : undefined
            }
            footer={entryFooter}
            surface={false}
          />
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
        ) : (
          <FeedbackNotice
            severity="neutral"
            title="No podcasts or media in this library yet."
          />
        )}
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

      {editOpen && (
        <LibraryEditDialog
          open={editOpen}
          onClose={closeEditDialog}
          library={editLibraryForDialog}
          members={editMembers}
          invites={editInvites}
          onRename={handleRename}
          onUpdateMemberRole={handleUpdateMemberRole}
          onRemoveMember={handleRemoveMember}
          onCreateInvite={handleCreateInvite}
          onRevokeInvite={handleRevokeInvite}
          onDelete={handleDeleteFromDialog}
          onSearchUsers={handleSearchUsers}
        />
      )}
    </>
  );
}
