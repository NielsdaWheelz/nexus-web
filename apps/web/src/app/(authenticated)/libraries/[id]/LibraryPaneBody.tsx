"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { flushSync } from "react-dom";
import { dispatchOpenAddContent } from "@/components/addContentEvents";
import { apiFetch, isApiError } from "@/lib/api/client";
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
  BarChart3,
  BookOpen,
  FileText,
  Globe,
  List,
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
import { fetchPodcastLibraries } from "@/app/(authenticated)/podcasts/podcastSubscriptions";
import LibraryIntelligenceView from "./LibraryIntelligenceView";
import ContributorCreditList from "@/components/contributors/ContributorCreditList";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import SectionCard from "@/components/ui/SectionCard";
import SortableList from "@/components/sortable/SortableList";
import LibraryEditDialog from "@/components/LibraryEditDialog";
import type { LibraryTargetPickerItem } from "@/components/LibraryTargetPicker";
import type {
  LibraryForEdit,
  LibraryMember,
  LibraryInvite,
  UserSearchResult,
} from "@/components/LibraryEditDialog";
import { usePaneChromeOverride } from "@/components/workspace/PaneShell";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import {
  usePaneParam,
  usePaneRouter,
  usePaneSearchParams,
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
  capabilities?: {
    can_delete?: boolean;
    can_retry?: boolean;
    can_refresh_source?: boolean;
  };
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

type LibraryView = "contents" | "intelligence";

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
  const paneSearchParams = usePaneSearchParams();
  const feedback = useFeedback();
  const [library, setLibrary] = useState<Library | null>(null);
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const removedEntryIds = useStringIdSet();
  const retryingMediaIds = useStringIdSet();
  const refreshingMediaIds = useStringIdSet();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  const [activeView, setActiveView] = useState<LibraryView>(() =>
    paneSearchParams.get("view") === "intelligence"
      ? "intelligence"
      : "contents",
  );
  useSetPaneTitle(library?.name ?? (loading ? null : "Library"));

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

  useEffect(() => {
    setActiveView(
      paneSearchParams.get("view") === "intelligence"
        ? "intelligence"
        : "contents",
    );
  }, [paneSearchParams]);
  const libraryPanelEntryIdRef = useRef<string | null>(null);

  const { clear: clearRemovedEntryIds } = removedEntryIds;
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [libraryResp, entriesResp] = await Promise.all([
          apiFetch<{ data: Library }>(`/api/libraries/${id}`),
          apiFetch<{ data: LibraryEntry[] }>(`/api/libraries/${id}/entries`),
        ]);
        setLibrary(libraryResp.data);
        setEntries(entriesResp.data);
        clearRemovedEntryIds();
        setError(null);
      } catch (err) {
        if (isApiError(err) && err.status === 404) {
          router.push("/libraries");
          return;
        }
        setError(toFeedback(err, { fallback: "Failed to load library" }));
      } finally {
        setLoading(false);
      }
    };

    void fetchData();
  }, [clearRemovedEntryIds, id, router]);

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
    (href: string, title: string, openInNewPane: boolean) => {
      if (openInNewPane) {
        if (!requestOpenInAppPane(href, { titleHint: title })) {
          window.location.assign(href);
        }
        return;
      }
      router.push(href);
    },
    [router],
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
      capabilityPatch: Partial<{
        can_delete: boolean;
        can_retry: boolean;
        can_refresh_source: boolean;
      }>;
    }) => {
      if (args.busySet.ids.has(args.mediaId)) return;
      args.busySet.add(args.mediaId);
      try {
        await apiFetch(`/api/media/${args.mediaId}${args.endpoint}`, {
          method: "POST",
        });
        setEntries((current) =>
          current.map((entry) =>
            entry.kind === "media" && entry.media.id === args.mediaId
              ? {
                  ...entry,
                  media: {
                    ...entry.media,
                    processing_status: "extracting",
                    capabilities: {
                      ...(entry.media.capabilities ?? {}),
                      ...args.capabilityPatch,
                    },
                  },
                }
              : entry,
          ),
        );
        feedback.show({ severity: "success", title: args.successTitle });
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
    if (!library || library.is_default) {
      return;
    }
    if (!confirm(`Delete "${library.name}"? This cannot be undone.`)) {
      return;
    }

    try {
      await apiFetch(`/api/libraries/${library.id}`, {
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
    if (!library) return;
    setEditOpen(true);
    try {
      const [membersResp, invitesResp] = await Promise.all([
        library.role === "admin"
          ? apiFetch<{ data: LibraryMember[] }>(
              `/api/libraries/${library.id}/members`,
            )
          : Promise.resolve({ data: [] as LibraryMember[] }),
        library.role === "admin"
          ? apiFetch<{ data: LibraryInvite[] }>(
              `/api/libraries/${library.id}/invites`,
            )
          : Promise.resolve({ data: [] as LibraryInvite[] }),
      ]);
      setEditMembers(membersResp.data);
      setEditInvites(invitesResp.data);
    } catch (err) {
      if (isApiError(err)) {
        setError(
          toFeedback(err, {
            fallback: "Failed to load library sharing",
          }),
        );
      }
    }
  }, [library]);

  const closeEditDialog = useCallback(() => {
    setEditOpen(false);
    setEditMembers([]);
    setEditInvites([]);
  }, []);

  const handleRename = useCallback(
    async (name: string) => {
      if (!library) return;
      await apiFetch(`/api/libraries/${library.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      setLibrary({ ...library, name });
    },
    [library],
  );

  const handleUpdateMemberRole = useCallback(
    async (userId: string, role: string) => {
      if (!library) return;
      await apiFetch(`/api/libraries/${library.id}/members/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      setEditMembers((prev) =>
        prev.map((member) =>
          member.user_id === userId ? { ...member, role } : member,
        ),
      );
    },
    [library],
  );

  const handleRemoveMember = useCallback(
    async (userId: string) => {
      if (!library) return;
      await apiFetch(`/api/libraries/${library.id}/members/${userId}`, {
        method: "DELETE",
      });
      setEditMembers((prev) =>
        prev.filter((member) => member.user_id !== userId),
      );
    },
    [library],
  );

  const handleCreateInvite = useCallback(
    async (inviteeIdentifier: string, role: string) => {
      if (!library) return;
      const isEmail = inviteeIdentifier.includes("@");
      const response = await apiFetch<{ data: LibraryInvite }>(
        `/api/libraries/${library.id}/invites`,
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
    [library],
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
    if (!library) return;
    if (!confirm(`Delete "${library.name}"? This cannot be undone.`)) {
      return;
    }
    await apiFetch(`/api/libraries/${library.id}`, {
      method: "DELETE",
    });
    closeEditDialog();
    router.push("/libraries");
  }, [library, closeEditDialog, router]);

  const handleOpenLibraryChat = useCallback(async () => {
    if (!library) {
      return;
    }

    try {
      const response = await apiFetch<{ data: { id: string; title: string } }>(
        "/api/conversations/resolve",
        {
          method: "POST",
          body: JSON.stringify({ type: "library", library_id: library.id }),
        },
      );
      const route = `/conversations/${response.data.id}`;
      if (
        !requestOpenInAppPane(route, {
          titleHint: response.data.title || library.name,
        })
      ) {
        router.push(route);
      }
    } catch (err) {
      setError(
        toFeedback(err, {
          fallback: "Failed to open library chat",
        }),
      );
    }
  }, [library, router]);

  const handleOpenMediaChat = useCallback(
    async (media: LibraryMediaEntry) => {
      try {
        const response = await apiFetch<{
          data: { id: string; title: string };
        }>("/api/conversations/resolve", {
          method: "POST",
          body: JSON.stringify({ type: "media", media_id: media.id }),
        });
        const route = `/conversations/${response.data.id}`;
        if (
          !requestOpenInAppPane(route, {
            titleHint: response.data.title || media.title,
          })
        ) {
          router.push(route);
        }
      } catch (err) {
        setError(
          toFeedback(err, {
            fallback: "Failed to open media chat",
          }),
        );
      }
    },
    [router],
  );

  const handleReorderEntries = (nextEntries: LibraryEntry[]) => {
    if (!library || library.role !== "admin") {
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

  const paneOptions = library
    ? [
        {
          id: "add-content",
          label: "Add content",
          restoreFocusOnClose: false,
          onSelect: () => dispatchOpenAddContent("content"),
        },
        ...libraryResourceOptions({
          library,
          onOpenChat: () => void handleOpenLibraryChat(),
          onViewIntelligence: () => setActiveView("intelligence"),
          onEdit: () => void openEditDialog(),
          onDelete: () => {
            void handleDeleteLibrary();
          },
        }),
      ]
    : [];

  usePaneChromeOverride({ options: paneOptions });

  if (loading) {
    return <FeedbackNotice severity="info" title="Loading library..." />;
  }

  if (!library) {
    return (
      <FeedbackNotice
        {...(error ?? { severity: "error", title: "Library not found" })}
      />
    );
  }

  const editLibraryForDialog: LibraryForEdit = {
    id: library.id,
    name: library.name,
    is_default: library.is_default,
    role: library.role,
    owner_user_id: library.owner_user_id,
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

          <div
            className={styles.viewSwitch}
            role="tablist"
            aria-label="Library view"
          >
            <Button
              variant="ghost"
              size="sm"
              role="tab"
              aria-selected={activeView === "contents"}
              className={styles.viewButton}
              onClick={() => setActiveView("contents")}
              leadingIcon={<List size={16} aria-hidden="true" />}
            >
              Contents
            </Button>
            <Button
              variant="ghost"
              size="sm"
              role="tab"
              aria-selected={activeView === "intelligence"}
              className={styles.viewButton}
              onClick={() => setActiveView("intelligence")}
              leadingIcon={<BarChart3 size={16} aria-hidden="true" />}
            >
              Intelligence
            </Button>
          </div>

          {activeView === "intelligence" ? (
            <LibraryIntelligenceView libraryId={id} />
          ) : visibleEntries.length === 0 ? (
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
                  library.role === "admin"
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
                    canUsePodcastActions: library.role === "admin",
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
                        {library.role === "admin" && (
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
                      {library.role === "admin" && (
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
