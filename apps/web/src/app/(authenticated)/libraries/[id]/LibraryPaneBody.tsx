"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { flushSync } from "react-dom";
import { dispatchOpenAddContent } from "@/components/addContentEvents";
import { apiFetch, isApiError } from "@/lib/api/client";
import {
  libraryEntriesResource,
  libraryResource as libraryResourceDescriptor,
} from "@/lib/api/resource";
import {
  runSourceProcessingAction,
} from "@/lib/media/sourceActions";
import type { MediaActionCapabilities } from "@/lib/media/ingestionClient";
import {
  FeedbackNotice,
  toFeedback,
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import {
  libraryResourceOptions,
  mediaResourceOptions,
  podcastResourceOptions,
} from "@/lib/actions/resourceActions";
import {
  BookOpen,
  FileText,
  Globe,
  Mic,
  Radio,
  Video,
} from "lucide-react";
import LibraryMembershipPanel from "@/components/LibraryMembershipPanel";
import {
  addMediaToLibrary,
  fetchMediaLibraryMemberships,
  patchLibraryMembership,
  removeMediaFromLibrary,
} from "@/lib/media/mediaLibraries";
import { useStringIdSet, type StringIdSet } from "@/lib/useStringIdSet";
import { useResource } from "@/lib/api/useResource";
import { fetchPodcastLibraries } from "@/app/(authenticated)/podcasts/podcastSubscriptions";
import LibraryIntelligenceView from "./LibraryIntelligenceView";
import LibraryChatTab from "@/components/chat/LibraryChatTab";
import ContributorCreditList from "@/components/contributors/ContributorCreditList";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import SectionCard from "@/components/ui/SectionCard";
import SortableList from "@/components/sortable/SortableList";
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
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import type { ContributorCredit } from "@/lib/contributors/types";
import styles from "./page.module.css";

const MEDIA_KIND_ICONS: Record<string, typeof Globe> = {
  podcast_episode: Mic,
  video: Video,
  epub: BookOpen,
  pdf: FileText,
};

interface Library {
  id: string;
  name: string;
  is_default: boolean;
  role: string;
  owner_user_id: string;
}

interface LibraryMediaEntry {
  id: string;
  kind: string;
  title: string;
  contributors: ContributorCredit[];
  published_date: string | null;
  publisher: string | null;
  canonical_source_url: string | null;
  processing_status:
    | "pending"
    | "extracting"
    | "ready_for_reading"
    | "embedding"
    | "ready"
    | "failed";
  capabilities?: Partial<MediaActionCapabilities>;
}

function normalizeMediaProcessingStatus(
  value: string,
): LibraryMediaEntry["processing_status"] {
  if (
    value === "pending" ||
    value === "extracting" ||
    value === "ready_for_reading" ||
    value === "embedding" ||
    value === "ready" ||
    value === "failed"
  ) {
    return value;
  }
  return "failed";
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

function hasContributorLinks(
  contributors: ContributorCredit[] | null | undefined,
): boolean {
  return Array.isArray(contributors)
    ? contributors.some((credit) => credit.contributor_handle?.trim())
    : false;
}

function isInteractiveRowTarget(
  target: EventTarget | null,
  currentTarget: HTMLElement,
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const interactive = target.closest(
    'a, button, input, textarea, select, [role="button"], [role="menuitem"]',
  );
  return Boolean(interactive && currentTarget.contains(interactive));
}

export default function LibraryPaneBody() {
  const id = usePaneParam("id");
  if (!id) {
    throw new Error("library route requires an id");
  }
  const router = usePaneRouter();
  const { openInNewPane, requestSecondarySurface } = usePaneRuntime() ?? {};
  const feedback = useFeedback();
  const [library, setLibrary] = useState<Library | null>(null);
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const removedEntryIds = useStringIdSet();
  const retryingMediaIds = useStringIdSet();
  const refreshingMediaIds = useStringIdSet();
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  const libraryResource = useResource<{
    library: Library;
    entries: LibraryEntry[];
  }, { id: string }>({
    descriptor: libraryResourceDescriptor,
    params: { id },
    load: async (params, signal) => {
      const [libraryResp, entriesResp] = await Promise.all([
        apiFetch<{ data: Library }>(
          libraryResourceDescriptor.clientPath(params),
          { signal },
        ),
        apiFetch<{ data: LibraryEntry[] }>(
          libraryEntriesResource.clientPath(params),
          { signal },
        ),
      ]);
      return { library: libraryResp.data, entries: entriesResp.data };
    },
  });
  const currentLibrary = library?.id === id ? library : null;
  const loading =
    libraryResource.status === "loading" && currentLibrary === null;
  useSetPaneTitle(currentLibrary?.name ?? (loading ? null : "Library"));

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

  const { clear: clearRemovedEntryIds } = removedEntryIds;
  useEffect(() => {
    if (libraryResource.status === "ready") {
      setLibrary(libraryResource.data.library);
      setEntries(libraryResource.data.entries);
      clearRemovedEntryIds();
      setError(null);
      return;
    }

    if (libraryResource.status === "error") {
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
    }
  }, [clearRemovedEntryIds, id, libraryResource, router]);

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

  const openLibraryEntry = useCallback(
    (href: string, title: string, openInSeparatePane: boolean) => {
      if (openInSeparatePane) {
        openInNewPane?.(href, title);
        return;
      }
      router.push(href, { titleHint: title });
    },
    [openInNewPane, router],
  );

  const handleLibraryEntryRowClick = useCallback(
    (event: MouseEvent<HTMLDivElement>, href: string, title: string) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isInteractiveRowTarget(event.target, event.currentTarget)
      ) {
        return;
      }
      event.preventDefault();
      openLibraryEntry(href, title, event.shiftKey);
    },
    [openLibraryEntry],
  );

  const handleLibraryEntryRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, href: string, title: string) => {
      if (
        event.target !== event.currentTarget ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (event.key !== "Enter" && event.key !== " ")
      ) {
        return;
      }
      event.preventDefault();
      openLibraryEntry(href, title, event.shiftKey);
    },
    [openLibraryEntry],
  );

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
          nextProcessingStatus = normalizeMediaProcessingStatus(
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
          nextProcessingStatus = normalizeMediaProcessingStatus(
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

  const handleOpenLibraryChat = useCallback(() => {
    requestSecondarySurface?.("library-chat");
  }, [requestSecondarySurface]);

  const handleOpenLibraryIntelligence = useCallback(() => {
    requestSecondarySurface?.("library-intelligence");
  }, [requestSecondarySurface]);

  const handleOpenFullLibraryChat = useCallback(
    (conversationId: string) => {
      openInNewPane?.(
        `/conversations/${conversationId}`,
        currentLibrary?.name,
      );
    },
    [currentLibrary?.name, openInNewPane],
  );

  const handleOpenMediaChat = useCallback(
    async (media: LibraryMediaEntry) => {
      try {
        const response = await apiFetch<{
          data: { id: string };
        }>("/api/conversations", {
          method: "POST",
          body: JSON.stringify({ initial_references: [`media:${media.id}`] }),
        });
        const route = `/conversations/${response.data.id}`;
        openInNewPane?.(route, media.title);
      } catch (err) {
        setError(
          toFeedback(err, {
            fallback: "Failed to open media chat",
          }),
        );
      }
    },
    [openInNewPane],
  );

  const handleReorderEntries = (nextEntries: LibraryEntry[]) => {
    if (!currentLibrary || currentLibrary.role !== "admin") {
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
        {
          id: "add-content",
          label: "Add content",
          restoreFocusOnClose: false,
          onSelect: () => dispatchOpenAddContent("content"),
        },
        ...libraryResourceOptions({
          library: currentLibrary,
          onOpenChat: handleOpenLibraryChat,
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
            defaultSurfaceId: "library-chat" as const,
            surfaces: [
              {
                id: "library-chat" as const,
                body: (
                  <LibraryChatTab
                    libraryId={id}
                    onOpenChat={handleOpenFullLibraryChat}
                  />
                ),
              },
              {
                id: "library-intelligence" as const,
                body: <LibraryIntelligenceView libraryId={id} />,
              },
            ],
          }
        : null,
    [currentLibrary, handleOpenFullLibraryChat, id],
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
      <SectionCard>
        <div className={styles.content}>
          {error && <FeedbackNotice {...error} />}

          {visibleEntries.length === 0 ? (
            <FeedbackNotice
              severity="neutral"
              title="No podcasts or media in this library yet."
            />
          ) : (
            <SortableList
              key={visibleEntries.map((entry) => entry.id).join(":")}
              className={styles.mediaList}
              itemClassName={styles.mediaListItem}
              items={visibleEntries}
              getItemId={(entry) => entry.id}
              onReorder={handleReorderEntries}
              renderItem={({ item, handleProps, isDragging }) => {
                const dragHandleBindings =
                  currentLibrary.role === "admin"
                    ? {
                        ...handleProps.attributes,
                        ...handleProps.listeners,
                      }
                    : undefined;
                if (item.kind === "podcast") {
                  const subscription = item.subscription;
                  const hasContributors = hasContributorLinks(
                    item.podcast.contributors,
                  );
                  const podcastMetaParts = [
                    subscription?.status === "active"
                      ? subscription.sync_status
                      : "unsubscribed",
                    item.podcast.unplayed_count > 0
                      ? `${item.podcast.unplayed_count} new`
                      : null,
                  ].filter(Boolean);
                  const rowOptions = podcastResourceOptions({
                    canUsePodcastActions: currentLibrary.role === "admin",
                    onManageLibraries: ({ triggerEl }) => {
                      void openLibraryPanel(item, triggerEl);
                    },
                  });
                  const href = `/podcasts/${item.podcast.id}`;
                  return (
                    <div
                      className={styles.mediaRow}
                      data-dragging={isDragging ? "true" : "false"}
                      role="link"
                      tabIndex={0}
                      onClick={(event) =>
                        handleLibraryEntryRowClick(
                          event,
                          href,
                          item.podcast.title,
                        )
                      }
                      onKeyDown={(event) =>
                        handleLibraryEntryRowKeyDown(
                          event,
                          href,
                          item.podcast.title,
                        )
                      }
                    >
                      <div className={styles.mediaRowMain}>
                        {currentLibrary.role === "admin" && (
                          <Button
                            variant="secondary"
                            size="sm"
                            className={styles.dragHandle}
                            aria-label={`Reorder ${item.podcast.title}`}
                            disabled={reorderBusy}
                            {...dragHandleBindings}
                          >
                            ⋮⋮
                          </Button>
                        )}
                        <div className={styles.mediaLink}>
                          <span className={styles.mediaTitleRow}>
                            <Radio size={18} aria-hidden="true" />
                            <span className={styles.mediaTitle}>
                              {item.podcast.title}
                            </span>
                          </span>
                          {hasContributors || podcastMetaParts.length > 0 ? (
                            <span className={styles.mediaMetaRow}>
                              <ContributorCreditList
                                credits={item.podcast.contributors}
                                maxVisible={1}
                              />
                              {podcastMetaParts.length > 0 ? (
                                <span className={styles.mediaMeta}>
                                  {podcastMetaParts.join(" · ")}
                                </span>
                              ) : null}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {rowOptions.length > 0 ? (
                        <ActionMenu
                          options={rowOptions}
                          className={styles.rowActionMenu}
                        />
                      ) : null}
                    </div>
                  );
                }

                const Icon = MEDIA_KIND_ICONS[item.media.kind] ?? Globe;
                const retryProcessingBusy = retryingMediaIds.ids.has(item.media.id);
                const refreshSourceBusy = refreshingMediaIds.ids.has(item.media.id);
                const rowOptions = mediaResourceOptions({
                  media: item.media,
                  canManageLibraries: true,
                  retryBusy: retryProcessingBusy,
                  refreshBusy: refreshSourceBusy,
                  onRetry: item.media.capabilities?.can_retry
                    ? () => {
                        void handleRetryProcessing(item.media.id);
                      }
                    : undefined,
                  onRefreshSource: item.media.capabilities?.can_refresh_source
                    ? () => {
                        void handleRefreshSource(item.media.id);
                      }
                    : undefined,
                  onOpenChat: () => {
                    void handleOpenMediaChat(item.media);
                  },
                  onManageLibraries: ({ triggerEl }) => {
                    void openLibraryPanel(item, triggerEl);
                  },
                  onDelete: item.media.capabilities?.can_delete
                    ? () => {
                        void handleDeleteMedia(item);
                      }
                    : undefined,
                });
                const hasContributors = hasContributorLinks(
                  item.media.contributors,
                );
                let publishedDate = item.media.published_date?.trim() || null;
                if (
                  publishedDate &&
                  /^\d{4}-\d{2}-\d{2}T/.test(publishedDate)
                ) {
                  publishedDate = publishedDate.slice(0, 10);
                }
                const publisher = item.media.publisher?.trim() || null;
                const metaParts: string[] = [];
                if (publishedDate) {
                  metaParts.push(publishedDate);
                }
                if (!hasContributors && metaParts.length === 0 && publisher) {
                  metaParts.push(publisher);
                }
                let statusLabel: string | null = null;
                if (item.media.processing_status === "pending") {
                  statusLabel = "Queued";
                } else if (item.media.processing_status === "extracting") {
                  statusLabel = "Processing";
                } else if (item.media.processing_status === "embedding") {
                  statusLabel = "Indexing";
                } else if (item.media.processing_status === "failed") {
                  statusLabel = "Failed";
                }
                const href = `/media/${item.media.id}`;
                return (
                  <div
                    className={styles.mediaRow}
                    data-dragging={isDragging ? "true" : "false"}
                    role="link"
                    tabIndex={0}
                    onClick={(event) =>
                      handleLibraryEntryRowClick(event, href, item.media.title)
                    }
                    onKeyDown={(event) =>
                      handleLibraryEntryRowKeyDown(
                        event,
                        href,
                        item.media.title,
                      )
                    }
                  >
                    <div className={styles.mediaRowMain}>
                      {currentLibrary.role === "admin" && (
                        <Button
                          variant="secondary"
                          size="sm"
                          className={styles.dragHandle}
                          aria-label={`Reorder ${item.media.title}`}
                          disabled={reorderBusy}
                          {...dragHandleBindings}
                        >
                          ⋮⋮
                        </Button>
                      )}
                      <div className={styles.mediaLink}>
                        <span className={styles.mediaTitleRow}>
                          <Icon size={18} aria-hidden="true" />
                          <span className={styles.mediaTitle}>
                            {item.media.title}
                          </span>
                        </span>
                        {hasContributors ||
                        metaParts.length > 0 ||
                        statusLabel ? (
                          <span className={styles.mediaMetaRow}>
                            <ContributorCreditList
                              credits={item.media.contributors}
                              maxVisible={1}
                            />
                            {metaParts.length > 0 ? (
                              <span className={styles.mediaMeta}>
                                {metaParts.join(" · ")}
                              </span>
                            ) : null}
                            {statusLabel ? (
                              <span
                                className={styles.mediaStatus}
                                data-status={item.media.processing_status}
                              >
                                {statusLabel}
                              </span>
                            ) : null}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {rowOptions.length > 0 ? (
                      <ActionMenu
                        options={rowOptions}
                        className={styles.rowActionMenu}
                      />
                    ) : null}
                  </div>
                );
              }}
            />
          )}
        </div>
      </SectionCard>

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
