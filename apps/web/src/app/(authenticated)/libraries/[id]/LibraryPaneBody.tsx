"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { apiFetch, isApiError } from "@/lib/api/client";
import { BookOpen, FileText, Globe, Mic, Radio, Video } from "lucide-react";
import LibraryMembershipPanel from "@/components/LibraryMembershipPanel";
import StateMessage from "@/components/ui/StateMessage";
import ActionMenu from "@/components/ui/ActionMenu";
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
import { usePaneParam, usePaneRouter, useSetPaneTitle } from "@/lib/panes/paneRuntime";
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
  authors: Array<{ id: string; name: string; role: string | null }>;
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
}

interface LibraryPodcastEntry {
  id: string;
  title: string;
  author: string | null;
  feed_url: string;
  website_url: string | null;
  image_url: string | null;
  unplayed_count: number;
}

interface LibraryPodcastSubscription {
  status: "active" | "unsubscribed";
  sync_status: "pending" | "running" | "partial" | "complete" | "source_limited" | "failed";
}

interface LibraryEntry {
  id: string;
  position: number;
  created_at: string;
  kind: "media" | "podcast";
  media?: LibraryMediaEntry | null;
  podcast?: LibraryPodcastEntry | null;
  subscription?: LibraryPodcastSubscription | null;
}

export default function LibraryPaneBody() {
  const id = usePaneParam("id");
  if (!id) {
    throw new Error("library route requires an id");
  }
  const router = usePaneRouter();
  const [library, setLibrary] = useState<Library | null>(null);
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [removedEntryIds, setRemovedEntryIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  useSetPaneTitle(library?.name ?? "Library");

  const [editOpen, setEditOpen] = useState(false);
  const [editMembers, setEditMembers] = useState<LibraryMember[]>([]);
  const [editInvites, setEditInvites] = useState<LibraryInvite[]>([]);
  const [libraryPanelEntry, setLibraryPanelEntry] = useState<LibraryEntry | null>(null);
  const [libraryPanelAnchorEl, setLibraryPanelAnchorEl] =
    useState<HTMLElement | null>(null);
  const [libraryPanelLibraries, setLibraryPanelLibraries] = useState<
    LibraryTargetPickerItem[]
  >([]);
  const [libraryPanelLoading, setLibraryPanelLoading] = useState(false);
  const [libraryPanelBusy, setLibraryPanelBusy] = useState(false);
  const [libraryPanelError, setLibraryPanelError] = useState<string | null>(null);
  const libraryPanelRequestIdRef = useRef(0);
  const libraryPanelEntryIdRef = useRef<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [libraryResp, entriesResp] = await Promise.all([
          apiFetch<{ data: Library }>(`/api/libraries/${id}`),
          apiFetch<{ data: LibraryEntry[] }>(`/api/libraries/${id}/entries`),
        ]);
        for (const entry of entriesResp.data) {
          if (entry.kind === "media" && !entry.media) {
            throw new Error("Library entry is missing media payload");
          }
          if (entry.kind === "podcast" && !entry.podcast) {
            throw new Error("Library entry is missing podcast payload");
          }
        }
        setLibrary(libraryResp.data);
        setEntries(entriesResp.data);
        setRemovedEntryIds(new Set());
        setError(null);
      } catch (err) {
        if (isApiError(err)) {
          if (err.status === 404) {
            router.push("/libraries");
            return;
          }
          setError(err.message);
        } else if (err instanceof Error) {
          setError(err.message);
        } else {
          setError("Failed to load library");
        }
      } finally {
        setLoading(false);
      }
    };

    void fetchData();
  }, [id, router]);

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
        if (entry.kind === "podcast") {
          if (!entry.podcast) {
            throw new Error("Library entry is missing podcast payload");
          }
          const response = await apiFetch<{
            data: Array<{
              id: string;
              name: string;
              color: string | null;
              is_in_library: boolean;
              can_add: boolean;
              can_remove: boolean;
            }>;
          }>(`/api/podcasts/${entry.podcast.id}/libraries`);
          if (libraryPanelRequestIdRef.current !== requestId) {
            return;
          }
          setLibraryPanelLibraries(
            response.data.map((library) => ({
              id: library.id,
              name: library.name,
              color: library.color,
              isInLibrary: library.is_in_library,
              canAdd: library.can_add,
              canRemove: library.can_remove,
            }))
          );
          return;
        }

        if (entry.kind === "media") {
          if (!entry.media) {
            throw new Error("Library entry is missing media payload");
          }
          const response = await apiFetch<{
            data: Array<{
              id: string;
              name: string;
              color: string | null;
              is_in_library: boolean;
              can_add: boolean;
              can_remove: boolean;
            }>;
          }>(`/api/media/${entry.media.id}/libraries`);
          if (libraryPanelRequestIdRef.current !== requestId) {
            return;
          }
          setLibraryPanelLibraries(
            response.data.map((library) => ({
              id: library.id,
              name: library.name,
              color: library.color,
              isInLibrary: library.is_in_library,
              canAdd: library.can_add,
              canRemove: library.can_remove,
            }))
          );
          return;
        }

        const unsupportedKind: never = entry.kind;
        throw new Error(`Unsupported library entry kind: ${unsupportedKind}`);
      } catch (err) {
        if (libraryPanelRequestIdRef.current !== requestId) {
          return;
        }
        if (isApiError(err)) {
          setLibraryPanelError(err.message);
        } else if (err instanceof Error) {
          setLibraryPanelError(err.message);
        } else {
          setLibraryPanelError("Failed to load libraries");
        }
      } finally {
        if (libraryPanelRequestIdRef.current === requestId) {
          setLibraryPanelLoading(false);
        }
      }
    },
    []
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
          if (!libraryPanelEntry.podcast) {
            throw new Error("Library entry is missing podcast payload");
          }
          await apiFetch(`/api/libraries/${libraryId}/podcasts`, {
            method: "POST",
            body: JSON.stringify({ podcast_id: libraryPanelEntry.podcast.id }),
          });
        } else if (libraryPanelEntry.kind === "media") {
          if (!libraryPanelEntry.media) {
            throw new Error("Library entry is missing media payload");
          }
          await apiFetch(`/api/libraries/${libraryId}/media`, {
            method: "POST",
            body: JSON.stringify({ media_id: libraryPanelEntry.media.id }),
          });
        } else {
          const unsupportedKind: never = libraryPanelEntry.kind;
          throw new Error(`Unsupported library entry kind: ${unsupportedKind}`);
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
                : library
            )
          );
        }
      } catch (err) {
        if (isApiError(err)) {
          setLibraryPanelError(err.message);
        } else if (err instanceof Error) {
          setLibraryPanelError(err.message);
        } else {
          setLibraryPanelError("Failed to add item to library");
        }
      } finally {
        setLibraryPanelBusy(false);
      }
    },
    [libraryPanelBusy, libraryPanelEntry]
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
                entry.media &&
                candidate.kind === "media" &&
                candidate.media?.id === entry.media.id
              ) {
                return false;
              }
              if (
                entry.kind === "podcast" &&
                entry.podcast &&
                candidate.kind === "podcast" &&
                candidate.podcast?.id === entry.podcast.id
              ) {
                return false;
              }
              return true;
            })
          );
        });
        closeLibraryPanel();
      }

      try {
        if (entry.kind === "podcast") {
          if (!entry.podcast) {
            throw new Error("Library entry is missing podcast payload");
          }
          await apiFetch(`/api/libraries/${libraryId}/podcasts/${entry.podcast.id}`, {
            method: "DELETE",
          });
        } else if (entry.kind === "media") {
          if (!entry.media) {
            throw new Error("Library entry is missing media payload");
          }
          await apiFetch(`/api/libraries/${libraryId}/media/${entry.media.id}`, {
            method: "DELETE",
          });
        } else {
          const unsupportedKind: never = entry.kind;
          throw new Error(`Unsupported library entry kind: ${unsupportedKind}`);
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
                : library
            )
          );
        }
      } catch (err) {
        if (removingCurrentEntry) {
          setEntries(previousEntries);
          setRemovedEntryIds(previousRemovedEntryIds);
        }
        if (isApiError(err)) {
          setLibraryPanelError(err.message);
        } else if (err instanceof Error) {
          setLibraryPanelError(err.message);
        } else {
          setLibraryPanelError("Failed to remove item from library");
        }
      } finally {
        setLibraryPanelBusy(false);
      }
    },
    [closeLibraryPanel, entries, id, libraryPanelBusy, libraryPanelEntry, removedEntryIds]
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
        setError(err.message);
      } else {
        setError("Failed to delete library");
      }
    }
  };

  const openEditDialog = useCallback(async () => {
    if (!library) return;
    setEditOpen(true);
    try {
      const [membersResp, invitesResp] = await Promise.all([
        library.role === "admin"
          ? apiFetch<{ data: LibraryMember[] }>(`/api/libraries/${library.id}/members`)
          : Promise.resolve({ data: [] as LibraryMember[] }),
        library.role === "admin"
          ? apiFetch<{ data: LibraryInvite[] }>(`/api/libraries/${library.id}/invites`)
          : Promise.resolve({ data: [] as LibraryInvite[] }),
      ]);
      setEditMembers(membersResp.data);
      setEditInvites(invitesResp.data);
    } catch (err) {
      if (isApiError(err)) {
        setError(err.message);
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
    [library]
  );

  const handleUpdateMemberRole = useCallback(
    async (userId: string, role: string) => {
      if (!library) return;
      await apiFetch(`/api/libraries/${library.id}/members/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      setEditMembers((prev) =>
        prev.map((member) => (member.user_id === userId ? { ...member, role } : member))
      );
    },
    [library]
  );

  const handleRemoveMember = useCallback(
    async (userId: string) => {
      if (!library) return;
      await apiFetch(`/api/libraries/${library.id}/members/${userId}`, {
        method: "DELETE",
      });
      setEditMembers((prev) => prev.filter((member) => member.user_id !== userId));
    },
    [library]
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
              : { invitee_user_id: inviteeIdentifier, role }
          ),
        }
      );
      setEditInvites((prev) => [response.data, ...prev]);
    },
    [library]
  );

  const handleSearchUsers = useCallback(
    async (query: string): Promise<UserSearchResult[]> => {
      const response = await apiFetch<{ data: UserSearchResult[] }>(
        `/api/users/search?q=${encodeURIComponent(query)}`
      );
      return response.data;
    },
    []
  );

  const handleRevokeInvite = useCallback(async (inviteId: string) => {
    await apiFetch(`/api/libraries/invites/${inviteId}`, {
      method: "DELETE",
    });
    setEditInvites((prev) =>
      prev.map((invite) =>
        invite.id === inviteId ? { ...invite, status: "revoked" } : invite
      )
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
          setError(err.message);
          return;
        }
        setError("Failed to reorder library entries");
      })
      .finally(() => {
        setReorderBusy(false);
      });
  };

  const paneOptions = !library || library.is_default
    ? []
    : [
        {
          id: "edit-library",
          label: "Edit library",
          onSelect: () => void openEditDialog(),
        },
        ...(library?.role === "admin"
          ? [
              {
                id: "delete-library",
                label: "Delete library",
                tone: "danger" as const,
                onSelect: () => {
                  void handleDeleteLibrary();
                },
              },
            ]
          : []),
      ];

  usePaneChromeOverride({ options: paneOptions });

  if (loading) {
    return <StateMessage variant="loading">Loading library...</StateMessage>;
  }

  if (!library) {
    return <StateMessage variant="error">{error || "Library not found"}</StateMessage>;
  }

  const editLibraryForDialog: LibraryForEdit = {
    id: library.id,
    name: library.name,
    is_default: library.is_default,
    role: library.role,
    owner_user_id: library.owner_user_id,
  };
  const visibleEntries = entries.filter((entry) => !removedEntryIds.has(entry.id));

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
          {error && <StateMessage variant="error">{error}</StateMessage>}

          {visibleEntries.length === 0 ? (
            <StateMessage variant="empty">No podcasts or media in this library yet.</StateMessage>
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
                const rowOptions =
                  library.role === "admin"
                    ? [
                        {
                          id: "libraries",
                          label: "Libraries…",
                          restoreFocusOnClose: false,
                          onSelect: ({ triggerEl }: { triggerEl: HTMLButtonElement | null }) => {
                            void openLibraryPanel(item, triggerEl);
                          },
                        },
                      ]
                    : [];

                if (item.kind === "podcast") {
                  if (!item.podcast) {
                    throw new Error("Library entry is missing podcast payload");
                  }
                  const subscription = item.subscription;
                  return (
                    <div className={styles.mediaRow} data-dragging={isDragging ? "true" : "false"}>
                      <div className={styles.mediaRowMain}>
                        {library.role === "admin" && (
                          <button
                            type="button"
                            className={styles.dragHandle}
                            aria-label={`Reorder ${item.podcast.title}`}
                            disabled={reorderBusy}
                            {...dragHandleBindings}
                          >
                            ⋮⋮
                          </button>
                        )}
                        <a href={`/podcasts/${item.podcast.id}`} className={styles.mediaLink}>
                          <span className={styles.mediaTitleRow}>
                            <Radio size={18} aria-hidden="true" />
                            <span className={styles.mediaTitle}>{item.podcast.title}</span>
                          </span>
                          <span className={styles.mediaMeta}>
                            {[
                              item.podcast.author || "Unknown author",
                              subscription?.status === "active" ? subscription.sync_status : "unsubscribed",
                              item.podcast.unplayed_count > 0
                                ? `${item.podcast.unplayed_count} new`
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </a>
                      </div>
                      <ActionMenu options={rowOptions} className={styles.rowActionMenu} />
                    </div>
                  );
                }

                if (item.kind === "media") {
                  if (!item.media) {
                    throw new Error("Library entry is missing media payload");
                  }
                  const Icon = MEDIA_KIND_ICONS[item.media.kind] ?? Globe;
                  const authorNames = item.media.authors
                    .map((author) => author.name.trim())
                    .filter((name) => name.length > 0);
                  let authorSummary: string | null = null;
                  if (authorNames.length === 1) {
                    authorSummary = authorNames[0] ?? null;
                  } else if (authorNames.length > 1) {
                    authorSummary = `${authorNames[0]} +${authorNames.length - 1}`;
                  }
                  let publishedDate = item.media.published_date?.trim() || null;
                  if (publishedDate && /^\d{4}-\d{2}-\d{2}T/.test(publishedDate)) {
                    publishedDate = publishedDate.slice(0, 10);
                  }
                  const publisher = item.media.publisher?.trim() || null;
                  const metaParts: string[] = [];
                  if (authorSummary) {
                    metaParts.push(authorSummary);
                  }
                  if (publishedDate) {
                    metaParts.push(publishedDate);
                  }
                  if (metaParts.length === 0 && publisher) {
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
                  return (
                    <div className={styles.mediaRow} data-dragging={isDragging ? "true" : "false"}>
                      <div className={styles.mediaRowMain}>
                        {library.role === "admin" && (
                          <button
                            type="button"
                            className={styles.dragHandle}
                            aria-label={`Reorder ${item.media.title}`}
                            disabled={reorderBusy}
                            {...dragHandleBindings}
                          >
                            ⋮⋮
                          </button>
                        )}
                        <a href={`/media/${item.media.id}`} className={styles.mediaLink}>
                          <span className={styles.mediaTitleRow}>
                            <Icon size={18} aria-hidden="true" />
                            <span className={styles.mediaTitle}>{item.media.title}</span>
                          </span>
                          {metaParts.length > 0 || statusLabel ? (
                            <span className={styles.mediaMetaRow}>
                              {metaParts.length > 0 ? (
                                <span className={styles.mediaMeta}>{metaParts.join(" · ")}</span>
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
                        </a>
                      </div>
                      <ActionMenu options={rowOptions} className={styles.rowActionMenu} />
                    </div>
                  );
                }

                const unsupportedKind: never = item.kind;
                throw new Error(`Unsupported library entry kind: ${unsupportedKind}`);
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
