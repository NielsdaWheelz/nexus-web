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
  RefreshCw,
  Video,
} from "lucide-react";
import LibraryMembershipPanel from "@/components/LibraryMembershipPanel";
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
type LibraryIntelligenceStatus =
  | "current"
  | "stale"
  | "building"
  | "failed"
  | "unavailable";

interface LibraryIntelligenceEvidence {
  id: string;
  snippet: string;
}

interface LibraryIntelligenceClaim {
  id: string;
  claim_text: string;
  support_state: string;
  evidence: LibraryIntelligenceEvidence[];
}

interface LibraryIntelligenceSection {
  id: string;
  section_kind: string;
  title: string;
  body: string;
  ordinal: number;
  claims: LibraryIntelligenceClaim[];
}

interface LibraryIntelligenceCoverage {
  media_id: string | null;
  podcast_id: string | null;
  source_kind: "media" | "podcast";
  title: string;
  media_kind: string | null;
  readiness_state: string;
  chunk_count: number;
  included: boolean;
  exclusion_reason: string | null;
  source_updated_at: string | null;
}

interface LibraryIntelligenceBuild {
  build_id: string;
  status: string;
  phase: string;
  error_code: string | null;
  error: string | null;
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
}

interface LibraryIntelligence {
  library_id: string;
  status: LibraryIntelligenceStatus;
  source_count: number;
  chunk_count: number;
  updated_at: string | null;
  sections: LibraryIntelligenceSection[];
  coverage: LibraryIntelligenceCoverage[];
  build: LibraryIntelligenceBuild | null;
}

function formatLabel(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDateTime(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

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
  const [removedEntryIds, setRemovedEntryIds] = useState<Set<string>>(
    new Set(),
  );
  const [retryingMediaIds, setRetryingMediaIds] = useState<Set<string>>(
    new Set(),
  );
  const [refreshingMediaIds, setRefreshingMediaIds] = useState<Set<string>>(
    new Set(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  const [activeView, setActiveView] = useState<LibraryView>(() =>
    paneSearchParams.get("view") === "intelligence"
      ? "intelligence"
      : "contents",
  );
  const [intelligence, setIntelligence] = useState<LibraryIntelligence | null>(
    null,
  );
  const [intelligenceLoading, setIntelligenceLoading] = useState(false);
  const [intelligenceRefreshing, setIntelligenceRefreshing] = useState(false);
  const [intelligenceError, setIntelligenceError] =
    useState<FeedbackContent | null>(null);
  useSetPaneTitle(library?.name ?? "Library");

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

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [libraryResp, entriesResp] = await Promise.all([
          apiFetch<{ data: Library }>(`/api/libraries/${id}`),
          apiFetch<{ data: LibraryEntry[] }>(`/api/libraries/${id}/entries`),
        ]);
        setLibrary(libraryResp.data);
        setEntries(entriesResp.data);
        setRemovedEntryIds(new Set());
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
  }, [id, router]);

  const loadIntelligence = useCallback(async () => {
    setIntelligenceLoading(true);
    setIntelligenceError(null);
    try {
      const response = await apiFetch<{ data: LibraryIntelligence }>(
        `/api/libraries/${id}/intelligence`,
      );
      setIntelligence(response.data);
    } catch (err) {
      setIntelligenceError(
        toFeedback(err, { fallback: "Failed to load library intelligence" }),
      );
    } finally {
      setIntelligenceLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (activeView !== "intelligence" || intelligence || intelligenceLoading) {
      return;
    }
    void loadIntelligence();
  }, [activeView, intelligence, intelligenceLoading, loadIntelligence]);

  const handleRefreshIntelligence = useCallback(async () => {
    setIntelligenceRefreshing(true);
    setIntelligenceError(null);
    try {
      await apiFetch<{ data: { build_id: string; status: string } }>(
        `/api/libraries/${id}/intelligence/refresh`,
        { method: "POST" },
      );
      await loadIntelligence();
    } catch (err) {
      setIntelligenceError(
        toFeedback(err, { fallback: "Failed to refresh library intelligence" }),
      );
    } finally {
      setIntelligenceRefreshing(false);
    }
  }, [id, loadIntelligence]);

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
        const path =
          entry.kind === "podcast"
            ? `/api/podcasts/${entry.podcast.id}/libraries`
            : `/api/media/${entry.media.id}/libraries`;
        const response = await apiFetch<{
          data: Array<{
            id: string;
            name: string;
            color: string | null;
            is_default?: boolean;
            is_in_library: boolean;
            can_add: boolean;
            can_remove: boolean;
          }>;
        }>(path);
        if (libraryPanelRequestIdRef.current !== requestId) {
          return;
        }
        setLibraryPanelLibraries(
          response.data
            .filter((library) => !library.is_default)
            .map((library) => ({
              id: library.id,
              name: library.name,
              color: library.color,
              isInLibrary: library.is_in_library,
              canAdd: library.can_add,
              canRemove: library.can_remove,
            })),
        );
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
          await apiFetch(`/api/libraries/${libraryId}/media`, {
            method: "POST",
            body: JSON.stringify({ media_id: libraryPanelEntry.media.id }),
          });
        }

        if (libraryPanelEntryIdRef.current === libraryPanelEntry.id) {
          setLibraryPanelLibraries((current) =>
            current.map((library) =>
              library.id === libraryId
                ? {
                    ...library,
                    isInLibrary: true,
                    canAdd: false,
                    canRemove: true,
                  }
                : library,
            ),
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
      const previousRemovedEntryIds = removedEntryIds;
      setLibraryPanelBusy(true);
      setLibraryPanelError(null);

      if (removingCurrentEntry) {
        setRemovedEntryIds((current) => {
          const next = new Set(current);
          next.add(entry.id);
          return next;
        });
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
          await apiFetch(
            `/api/media/${entry.media.id}?library_id=${encodeURIComponent(libraryId)}`,
            { method: "DELETE" },
          );
        }

        if (removingCurrentEntry) {
          return;
        }

        if (libraryPanelEntryIdRef.current === entry.id) {
          setLibraryPanelLibraries((current) =>
            current.map((library) =>
              library.id === libraryId
                ? {
                    ...library,
                    isInLibrary: false,
                    canAdd: true,
                    canRemove: false,
                  }
                : library,
            ),
          );
        }
      } catch (err) {
        if (removingCurrentEntry) {
          setEntries(previousEntries);
          setRemovedEntryIds(previousRemovedEntryIds);
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

  const handleRetryProcessing = useCallback(
    async (mediaId: string) => {
      if (retryingMediaIds.has(mediaId)) {
        return;
      }

      setRetryingMediaIds((current) => new Set(current).add(mediaId));
      try {
        await apiFetch(`/api/media/${mediaId}/retry`, { method: "POST" });
        setEntries((current) =>
          current.map((entry) =>
            entry.kind === "media" && entry.media.id === mediaId
              ? {
                  ...entry,
                  media: {
                    ...entry.media,
                    processing_status: "extracting",
                    capabilities: {
                      ...(entry.media.capabilities ?? {}),
                      can_retry: false,
                    },
                  },
                }
              : entry,
          ),
        );
        feedback.show({
          severity: "success",
          title: "Processing retry started.",
        });
      } catch (err) {
        feedback.show({
          ...toFeedback(err, {
            fallback: "Failed to retry processing",
          }),
        });
      } finally {
        setRetryingMediaIds((current) => {
          const next = new Set(current);
          next.delete(mediaId);
          return next;
        });
      }
    },
    [feedback, retryingMediaIds],
  );

  const handleRefreshSource = useCallback(
    async (mediaId: string) => {
      if (refreshingMediaIds.has(mediaId)) {
        return;
      }

      setRefreshingMediaIds((current) => new Set(current).add(mediaId));
      try {
        await apiFetch(`/api/media/${mediaId}/refresh`, { method: "POST" });
        setEntries((current) =>
          current.map((entry) =>
            entry.kind === "media" && entry.media.id === mediaId
              ? {
                  ...entry,
                  media: {
                    ...entry.media,
                    processing_status: "extracting",
                    capabilities: {
                      ...(entry.media.capabilities ?? {}),
                      can_refresh_source: false,
                      can_retry: false,
                    },
                  },
                }
              : entry,
          ),
        );
        feedback.show({
          severity: "success",
          title: "Source refresh started.",
        });
      } catch (err) {
        feedback.show({
          ...toFeedback(err, {
            fallback: "Failed to refresh source",
          }),
        });
      } finally {
        setRefreshingMediaIds((current) => {
          const next = new Set(current);
          next.delete(mediaId);
          return next;
        });
      }
    },
    [feedback, refreshingMediaIds],
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

  const paneOptions = libraryResourceOptions({
    library,
    onOpenChat: () => void handleOpenLibraryChat(),
    onViewIntelligence: () => setActiveView("intelligence"),
    onEdit: () => void openEditDialog(),
    onDelete: () => {
      void handleDeleteLibrary();
    },
  });

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
    (entry) => !removedEntryIds.has(entry.id),
  );
  const intelligenceSections = intelligence?.sections ?? [];
  const updatedAt = formatDateTime(intelligence?.updated_at);
  const buildUpdatedAt = formatDateTime(
    intelligence?.build?.updated_at ??
      intelligence?.build?.completed_at ??
      null,
  );
  const buildStartedAt = formatDateTime(
    intelligence?.build?.started_at ?? null,
  );
  const intelligenceStatus = intelligence?.status ?? "unavailable";
  const buildStatus = intelligence?.build?.status ?? null;
  const statusText =
    intelligenceStatus === "building"
      ? "Building"
      : intelligenceStatus === "stale"
        ? "Stale"
        : intelligenceStatus === "failed"
          ? "Failed"
          : formatLabel(intelligenceStatus);

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
            <div className={styles.intelligenceView}>
              <div className={styles.intelligenceHeader}>
                <div className={styles.intelligenceTitleGroup}>
                  <h2 className={styles.intelligenceTitle}>Intelligence</h2>
                  <span
                    className={styles.intelligenceStatus}
                    data-status={intelligenceStatus}
                  >
                    {statusText}
                  </span>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleRefreshIntelligence()}
                  disabled={intelligenceLoading || intelligenceRefreshing}
                  leadingIcon={<RefreshCw size={16} aria-hidden="true" />}
                >
                  {intelligenceRefreshing ? "Refreshing" : "Refresh"}
                </Button>
              </div>

              {intelligenceError ? (
                <FeedbackNotice {...intelligenceError} />
              ) : null}

              {intelligenceLoading && !intelligence ? (
                <FeedbackNotice
                  severity="info"
                  title="Loading intelligence..."
                />
              ) : intelligence ? (
                <>
                  <div className={styles.intelligenceStats}>
                    <div className={styles.intelligenceStat}>
                      <span className={styles.statLabel}>Sources</span>
                      <strong>
                        {intelligence.source_count.toLocaleString()}
                      </strong>
                    </div>
                    <div className={styles.intelligenceStat}>
                      <span className={styles.statLabel}>Chunks</span>
                      <strong>
                        {intelligence.chunk_count.toLocaleString()}
                      </strong>
                    </div>
                    <div className={styles.intelligenceStat}>
                      <span className={styles.statLabel}>Updated</span>
                      <strong>{updatedAt ?? "Never"}</strong>
                    </div>
                  </div>

                  {(intelligenceStatus === "stale" ||
                    intelligenceStatus === "building" ||
                    intelligenceStatus === "failed" ||
                    buildStatus) && (
                    <div
                      className={styles.buildState}
                      data-status={intelligenceStatus}
                      role={
                        intelligenceStatus === "failed" ? "alert" : "status"
                      }
                    >
                      <strong>
                        {intelligenceStatus === "stale"
                          ? "This intelligence is stale."
                          : intelligenceStatus === "building"
                            ? "A build is running."
                            : intelligenceStatus === "failed"
                              ? "The latest build failed."
                              : `Build ${formatLabel(buildStatus ?? "pending")}`}
                      </strong>
                      <span>
                        {intelligence.build?.error ||
                          [
                            buildStartedAt ? `Started ${buildStartedAt}` : null,
                            buildUpdatedAt ? `Updated ${buildUpdatedAt}` : null,
                          ]
                            .filter(Boolean)
                            .join(" · ") ||
                          "Refresh to rebuild this library intelligence."}
                      </span>
                    </div>
                  )}

                  <section className={styles.intelligenceSection}>
                    <h3>Overview</h3>
                    {intelligenceSections.length === 0 ? (
                      <p className={styles.mutedText}>
                        No overview sections are available yet.
                      </p>
                    ) : (
                      <div className={styles.sectionGrid}>
                        {intelligenceSections.map((section) => (
                          <article
                            className={styles.overviewSection}
                            key={section.id}
                          >
                            <h4>{section.title}</h4>
                            <p>{section.body}</p>
                            {section.claims.length > 0 ? (
                              <ul>
                                {section.claims.map((claim) => (
                                  <li key={claim.id}>
                                    {claim.claim_text}
                                    <span className={styles.claimState}>
                                      {formatLabel(claim.support_state)}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </article>
                        ))}
                      </div>
                    )}
                  </section>

                  <section className={styles.intelligenceSection}>
                    <h3>Coverage</h3>
                    {intelligence.coverage.length > 0 ? (
                      <dl className={styles.coverageList}>
                        {intelligence.coverage.map((source) => (
                          <div
                            className={styles.coverageItem}
                            key={
                              source.media_id ??
                              source.podcast_id ??
                              source.title
                            }
                          >
                            <dt>{source.title}</dt>
                            <dd>
                              {[
                                formatLabel(source.source_kind),
                                source.media_kind
                                  ? formatLabel(source.media_kind)
                                  : null,
                                source.included
                                  ? "Included"
                                  : formatLabel(
                                      source.exclusion_reason ?? "excluded",
                                    ),
                                `${source.chunk_count.toLocaleString()} chunks`,
                                formatLabel(source.readiness_state),
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p className={styles.mutedText}>
                        No coverage data is available yet.
                      </p>
                    )}
                  </section>
                </>
              ) : (
                <FeedbackNotice
                  severity="neutral"
                  title="No intelligence has been built yet."
                />
              )}
            </div>
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
                const retryProcessingBusy = retryingMediaIds.has(item.media.id);
                const refreshSourceBusy = refreshingMediaIds.has(item.media.id);
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
