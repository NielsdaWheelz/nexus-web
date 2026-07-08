"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { dispatchOpenLauncher } from "@/lib/launcher/launcherEvents";
import { apiFetch, isApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  libraryEntriesResource,
  libraryResource as libraryResourceDescriptor,
} from "@/lib/api/resource";
import { runSourceProcessingAction } from "@/lib/media/sourceActions";
import type { MediaActionCapabilities } from "@/lib/media/ingestionClient";
import {
  requireDocumentProcessingStatus,
  type DocumentProcessingStatus,
} from "@/lib/media/documentReadiness";
import {
  FeedbackNotice,
  toFeedback,
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { libraryResourceOptions } from "@/lib/actions/resourceActions";
import { presentMedia } from "@/lib/collections/presenters/media";
import { presentPodcast } from "@/lib/collections/presenters/podcast";
import { startResourceChat } from "@/lib/resources/resourceChat";
import LibraryMembershipPanel from "@/components/LibraryMembershipPanel";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import {
  addMediaToLibrary,
  fetchMediaLibraryMemberships,
  patchLibraryMembership,
  removeMediaFromLibrary,
} from "@/lib/media/mediaLibraries";
import { useStringIdSet, type StringIdSet } from "@/lib/useStringIdSet";
import { clientResourceFetcher } from "@/lib/api/resourceTransport.client";
import { useResource } from "@/lib/api/useResource";
import { paneResourceLoaders } from "@/lib/panes/paneResourceLoaders";
import { fetchPodcastLibraries } from "@/app/(authenticated)/podcasts/podcastSubscriptions";
import LibraryIntelligencePane from "./LibraryIntelligencePane";
import Button from "@/components/ui/Button";
import PaneSurface from "@/components/ui/PaneSurface";
import CollectionView from "@/components/collections/CollectionView";
import CollectionDisplayControls from "@/components/collections/CollectionDisplayControls";
import PaneSection from "@/components/ui/PaneSection";
import PaneToolbar from "@/components/ui/PaneToolbar";
import SortSelect from "@/components/ui/SortSelect";
import type { CollectionRowView } from "@/lib/collections/types";
import { useConnectionSummaries } from "@/lib/collections/useConnectionSummaries";
import { useCollectionDisplayState } from "@/lib/collections/useCollectionDisplayState";
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
import { usePaneChromeOverride } from "@/components/workspace/PaneShell";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { usePaneSecondary } from "@/components/workspace/PaneSecondary";
import {
  usePaneParam,
  usePaneRouter,
  usePaneRuntime,
  usePaneSearchParams,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import type { ContributorCredit } from "@/lib/contributors/types";
import { isAbortError } from "@/lib/errors";
import styles from "./page.module.css";

interface Library {
  id: string;
  name: string;
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
  kind: string;
  title: string;
  contributors: ContributorCredit[];
  published_date: string | null;
  publisher: string | null;
  canonical_source_url: string | null;
  processing_status: DocumentProcessingStatus;
  read_state?: "unread" | "in_progress" | "finished" | null;
  progress_fraction?: number | null;
  last_engaged_at?: string | null;
  capabilities?: Partial<MediaActionCapabilities>;
}

interface LibraryPodcastEntry {
  id: string;
  title: string;
  contributors: ContributorCredit[];
  feed_url: string;
  website_url: string | null;
  image_url: string | null;
  unplayed_count: number;
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
  read_state?: "unread" | "in_progress" | "finished" | null;
  progress_fraction?: number | null;
  last_engaged_at?: string | null;
  surfaced_today?: boolean;
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

interface LibraryPageInfo {
  has_more: boolean;
  next_cursor: string | null;
}

interface LibraryEntryPage {
  data: LibraryEntry[];
  page: LibraryPageInfo;
}

interface LibraryPaneResource {
  library: Library;
  entries: LibraryEntry[];
  entriesPage: LibraryPageInfo;
}

function appendUniqueEntries(current: LibraryEntry[], next: LibraryEntry[]): LibraryEntry[] {
  const seen = new Set(current.map((entry) => entry.id));
  const merged = [...current];
  for (const entry of next) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

export default function LibraryPaneBody() {
  const id = usePaneParam("id");
  if (!id) {
    throw new Error("library route requires an id");
  }
  const router = usePaneRouter();
  const paneSearchParams = usePaneSearchParams();
  const selectedTab = paneSearchParams.get("tab");
  const { displayState, setDisplayState } = useCollectionDisplayState(`/libraries/${id}`);
  const { openInNewPane, requestSecondarySurface } = usePaneRuntime() ?? {};
  const feedback = useFeedback();
  const [library, setLibrary] = useState<Library | null>(null);
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [entryCursor, setEntryCursor] = useState<string | null>(null);
  const [manualLoadingMore, setManualLoadingMore] = useState(false);
  const [manualLoadMoreError, setManualLoadMoreError] = useState<FeedbackContent | null>(null);
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
  const sort = paneSearchParams.get("sort") === "resonance" ? "resonance" : "manual";
  // Entry mutation (add content, reorder, remove) is hidden for system-protected
  // libraries (e.g. the Oracle Corpus), which report can_edit_entries === false.
  const canEditEntries =
    currentLibrary?.role === "admin" && currentLibrary.can_edit_entries === true;
  const loading =
    libraryResource.status === "loading" && currentLibrary === null;
  useSetPaneTitle(currentLibrary?.name ?? (loading ? null : "Library"));
  const connectionSummaryEntries = sort === "resonance" ? resonanceEntries : entries;
  const connectionSummaries = useConnectionSummaries(
    connectionSummaryEntries.map((entry) =>
      entry.kind === "podcast" ? `podcast:${entry.podcast.id}` : `media:${entry.media.id}`,
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
  const resonanceEntriesPath = libraryEntriesResource.clientPath({ id, sort: "resonance" });
  const resonanceFetch = useDebouncedFetch<LibraryEntryPage>(
    sort === "resonance" ? resonanceEntriesPath : null,
    (signal) => apiFetch<LibraryEntryPage>(resonanceEntriesPath, { signal }),
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
  }, [cancelEntryLoadMore, id]);

  const { clear: clearRemovedEntryIds } = removedEntryIds;
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
            : await fetchMediaLibraryMemberships(entry.media.id, {
                excludeDefault: true,
              });
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
          await apiFetch(`/api/libraries/${libraryId}/podcasts`, {
            method: "POST",
            body: JSON.stringify({ podcast_id: libraryPanelEntry.podcast.id }),
          });
        } else {
          await addMediaToLibrary(libraryPanelEntry.media.id, libraryId);
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
          await apiFetch(
            `/api/libraries/${libraryId}/podcasts/${entry.podcast.id}`,
            {
              method: "DELETE",
            },
          );
        } else {
          await removeMediaFromLibrary(entry.media.id, libraryId);
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
      endpoint: string;
      successTitle: string;
      errorFallback: string;
      capabilityPatch: Partial<MediaActionCapabilities>;
    }) => {
      if (args.busySet.ids.has(args.mediaId)) return;
      args.busySet.add(args.mediaId);
      try {
        let nextProcessingStatus: LibraryMediaEntry["processing_status"] =
          "extracting";
        let sourceFeedback: { severity: "success" | "warning"; title: string } = {
          severity: "success" as const,
          title: args.successTitle,
        };
        let capabilityPatch = args.capabilityPatch;
        if (args.endpoint === "/retry") {
          const projection = await runSourceProcessingAction({
            mediaId: args.mediaId,
            action: "retry",
            successTitle: args.successTitle,
          });
          nextProcessingStatus = requireDocumentProcessingStatus(
            projection.processingStatus,
          );
          capabilityPatch = projection.capabilityPatch;
          sourceFeedback = projection.feedback;
        } else if (args.endpoint === "/refresh") {
          const projection = await runSourceProcessingAction({
            mediaId: args.mediaId,
            action: "refresh",
            successTitle: args.successTitle,
          });
          nextProcessingStatus = requireDocumentProcessingStatus(
            projection.processingStatus,
          );
          capabilityPatch = projection.capabilityPatch;
          sourceFeedback = projection.feedback;
        } else {
          await apiFetch(`/api/media/${args.mediaId}${args.endpoint}`, {
            method: "POST",
          });
        }
        setEntries((current) =>
          current.map((entry) =>
            entry.kind === "media" && entry.media.id === args.mediaId
              ? {
                  ...entry,
                  media: {
                    ...entry.media,
                    processing_status: nextProcessingStatus,
                    capabilities: {
                      ...(entry.media.capabilities ?? {}),
                      ...capabilityPatch,
                    },
                  },
                }
              : entry,
          ),
        );
        feedback.show(sourceFeedback);
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        feedback.show({
          ...toFeedback(err, { fallback: args.errorFallback }),
        });
      } finally {
        args.busySet.remove(args.mediaId);
      }
    },
    [feedback],
  );

  const handleRetryProcessing = useCallback(
    (mediaId: string) =>
      runMediaProcessingMutation({
        mediaId,
        busySet: retryingMediaIds,
        endpoint: "/retry",
        successTitle: "Processing retry started.",
        errorFallback: "Failed to retry processing",
        capabilityPatch: { can_retry: false },
      }),
    [retryingMediaIds, runMediaProcessingMutation],
  );

  const handleRefreshSource = useCallback(
    (mediaId: string) =>
      runMediaProcessingMutation({
        mediaId,
        busySet: refreshingMediaIds,
        endpoint: "/refresh",
        successTitle: "Source refresh started.",
        errorFallback: "Failed to refresh source",
        capabilityPatch: { can_refresh_source: false, can_retry: false },
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
        await apiFetch(`/api/media/${entry.media.id}`, { method: "DELETE" });
        setEntries((current) =>
          current.filter(
            (candidate) =>
              candidate.kind !== "media" ||
              candidate.media.id !== entry.media.id,
          ),
        );
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

  const handleOpenLibraryIntelligence = useCallback(() => {
    requestSecondarySurface?.("library-intelligence");
  }, [requestSecondarySurface]);
  useEffect(() => {
    if (selectedTab === "intelligence") {
      requestSecondarySurface?.("library-intelligence");
    }
  }, [requestSecondarySurface, selectedTab]);

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
      const cursor = requestedSort === "resonance" ? resonanceCursor : entryCursor;
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
      void apiFetch<LibraryEntryPage>(
        libraryEntriesResource.clientPath({
          id,
          cursor,
          sort: requestedSort === "resonance" ? "resonance" : undefined,
        }),
        { signal: controller.signal },
      )
        .then((page) => {
          if (controller.signal.aborted || generation !== entryLoadMoreGenerationRef.current) {
            return;
          }
          if (requestedSort === "resonance") {
            setResonanceEntries((current) => appendUniqueEntries(current, page.data));
            setResonanceCursor(page.page.next_cursor);
          } else {
            setEntries((current) => appendUniqueEntries(current, page.data));
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
          if (controller.signal.aborted || generation !== entryLoadMoreGenerationRef.current) {
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
      manualLoadingMore,
      resonanceCursor,
      resonanceLoadingMore,
    ],
  );

  const handleReorderEntries = (nextEntries: LibraryEntry[]) => {
    if (!canEditEntries || entryCursor !== null) {
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

  const paneOptions = currentLibrary
    ? [
        ...(canEditEntries
          ? [
              {
                id: "add-content",
                label: "Add content",
                restoreFocusOnClose: false,
                onSelect: () => dispatchOpenLauncher({ lane: "add" }),
              },
            ]
          : []),
        ...libraryResourceOptions({
          library: currentLibrary,
          onViewIntelligence: handleOpenLibraryIntelligence,
          onEdit: () => void openEditDialog(),
          onDelete: () => {
            void handleDeleteLibrary();
          },
        }),
      ]
    : [];

  usePaneChromeOverride({ options: paneOptions });
  const secondaryDescriptor = useMemo(
    () =>
      currentLibrary
        ? {
            groupId: "library-tools" as const,
            defaultSurfaceId: "library-intelligence" as const,
            surfaces: [
              {
                id: "library-intelligence" as const,
                body: <LibraryIntelligencePane libraryId={id} />,
              },
            ],
          }
        : null,
    [currentLibrary, id],
  );
  usePaneSecondary(secondaryDescriptor);

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
  const surfacedEntries = visibleEntries.filter((entry) => entry.surfaced_today);
  const canReorderVisibleEntries = canEditEntries && sort === "manual" && entryCursor === null;
  const entryFooter =
    sort === "resonance" ? (
      <>
        {resonanceLoadMoreError ? <FeedbackNotice {...resonanceLoadMoreError} /> : null}
        <LoadMoreFooter
          hasMore={resonanceCursor !== null}
          loading={resonanceLoadingMore}
          onLoadMore={() => handleLoadMoreEntries("resonance")}
          label="Load more entries"
        />
      </>
    ) : (
      <>
        {manualLoadMoreError ? <FeedbackNotice {...manualLoadMoreError} /> : null}
        <LoadMoreFooter
          hasMore={entryCursor !== null}
          loading={manualLoadingMore}
          onLoadMore={() => handleLoadMoreEntries("manual")}
          label="Load more entries"
        />
      </>
    );
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
          image_url: item.podcast.image_url,
          contributors: item.podcast.contributors,
          unplayed_count: item.podcast.unplayed_count,
          sync_status:
            item.subscription?.status === "active"
              ? item.subscription.sync_status
              : "complete",
        },
        {
          canUsePodcastActions: canEditEntries,
          connectionSummary: connectionSummaries.get(`podcast:${item.podcast.id}`),
          onManageLibraries: ({ triggerEl }) => {
            void openLibraryPanel(item, triggerEl);
          },
        },
      );
      return { ...row, id: item.id };
    }
    const row = presentMedia(item.media, {
      canManageLibraries: canEditEntries,
      connectionSummary: connectionSummaries.get(`media:${item.media.id}`),
      retryBusy: retryingMediaIds.ids.has(item.media.id),
      refreshBusy: refreshingMediaIds.ids.has(item.media.id),
      onRetry:
        canEditEntries && item.media.capabilities?.can_retry
          ? () => {
              void handleRetryProcessing(item.media.id);
            }
          : undefined,
      onRefreshSource:
        canEditEntries && item.media.capabilities?.can_refresh_source
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
        canEditEntries && item.media.capabilities?.can_delete
          ? () => {
              void handleDeleteMedia(item);
            }
        : undefined,
    });
    return { ...row, id: item.id, relatedMediaId: item.media.id };
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
        toolbar={
          visibleEntries.length > 0 ? (
            <PaneToolbar
              controls={
                <>
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
                  <CollectionDisplayControls
                    value={displayState}
                    onChange={setDisplayState}
                  />
                </>
              }
            />
          ) : undefined
        }
        state={error ? <FeedbackNotice {...error} /> : null}
        empty={
          sort === "manual" && visibleEntries.length === 0 ? (
            <FeedbackNotice
              severity="neutral"
              title="No podcasts or media in this library yet."
            />
          ) : null
        }
      >
          {sort === "resonance" ? (
            <CollectionView
              rows={visibleResonanceEntries.map(entryRowView)}
              view={displayState.view}
              density={displayState.density}
              status={resonanceStatus}
              ariaLabel="Library by resonance"
              empty={<FeedbackNotice severity="neutral" title="No entries to rank yet." />}
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
            <>
          {surfacedEntries.length > 0 ? (
            <PaneSection title="Surfaced today">
              <CollectionView
                rows={surfacedEntries.map(entryRowView)}
                view={displayState.view}
                density={displayState.density}
                status="ready"
                ariaLabel="Surfaced today"
                surface={false}
              />
            </PaneSection>
          ) : null}
            {displayState.view === "gallery" ? (
              <CollectionView
                rows={visibleEntryRows}
                view="gallery"
                density={displayState.density}
                status="ready"
                ariaLabel="Library entries"
                footer={entryFooter}
                surface={false}
              />
            ) : (
              <CollectionView
                rows={visibleEntryRows}
                view="list"
                density={displayState.density}
                status="ready"
                ariaLabel="Library entries"
                footer={entryFooter}
                surface={false}
                sortable={
                  canReorderVisibleEntries
                    ? {
                        className: styles.mediaList,
                        itemClassName: styles.mediaListItem,
                        onReorder: (nextRows) => {
                          const byEntryId = new Map(
                            visibleEntries.map((entry) => [entry.id, entry]),
                          );
                          const nextEntries = nextRows
                            .map((row) => byEntryId.get(row.id))
                            .filter((entry): entry is LibraryEntry => entry !== undefined);
                          if (nextEntries.length === visibleEntries.length) {
                            handleReorderEntries(nextEntries);
                          }
                        },
                        renderControls: (row, { handleProps }) => (
                          <Button
                            variant="secondary"
                            size="sm"
                            className={styles.dragHandle}
                            aria-label={`Reorder ${row.headline.text}`}
                            disabled={reorderBusy}
                            {...handleProps.attributes}
                            {...handleProps.listeners}
                          >
                            ⋮⋮
                          </Button>
                        ),
                      }
                    : undefined
                }
              />
            )}
            </>
          ) : null}
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
