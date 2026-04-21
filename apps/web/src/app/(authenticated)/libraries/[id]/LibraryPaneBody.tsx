"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import { BookOpen, FileText, Globe, Mic, Radio, Video } from "lucide-react";
import StateMessage from "@/components/ui/StateMessage";
import ActionMenu from "@/components/ui/ActionMenu";
import SectionCard from "@/components/ui/SectionCard";
import SortableList from "@/components/sortable/SortableList";
import LibraryEditDialog from "@/components/LibraryEditDialog";
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  useSetPaneTitle(library?.name ?? "Library");

  const [editOpen, setEditOpen] = useState(false);
  const [editMembers, setEditMembers] = useState<LibraryMember[]>([]);
  const [editInvites, setEditInvites] = useState<LibraryInvite[]>([]);

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

  const handleRemoveEntry = async (entry: LibraryEntry) => {
    const entryTitle = entry.kind === "podcast" ? entry.podcast?.title : entry.media?.title;
    if (!entryTitle) {
      return;
    }
    if (!confirm(`Remove "${entryTitle}" from the library?`)) {
      return;
    }

    try {
      if (entry.kind === "podcast") {
        if (!entry.podcast) {
          throw new Error("Library entry is missing podcast payload");
        }
        await apiFetch(`/api/libraries/${id}/podcasts/${entry.podcast.id}`, {
          method: "DELETE",
        });
        setEntries((prev) => prev.filter((candidate) => candidate.id !== entry.id));
        return;
      }
      if (entry.kind === "media") {
        if (!entry.media) {
          throw new Error("Library entry is missing media payload");
        }
        await apiFetch(`/api/libraries/${id}/media/${entry.media.id}`, {
          method: "DELETE",
        });
        setEntries((prev) => prev.filter((candidate) => candidate.id !== entry.id));
        return;
      }

      const unsupportedKind: never = entry.kind;
      throw new Error(`Unsupported library entry kind: ${unsupportedKind}`);
    } catch (err) {
      if (isApiError(err)) {
        setError(err.message);
      } else {
        setError("Failed to remove library entry");
      }
    }
  };

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

  return (
    <>
      <SectionCard>
        <div className={styles.content}>
          {error && <StateMessage variant="error">{error}</StateMessage>}

          {entries.length === 0 ? (
            <StateMessage variant="empty">No podcasts or media in this library yet.</StateMessage>
          ) : (
            <SortableList
              className={styles.mediaList}
              itemClassName={styles.mediaListItem}
              items={entries}
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
                          id: "remove-from-library",
                          label: "Remove from library",
                          tone: "danger" as const,
                          onSelect: () => {
                            void handleRemoveEntry(item);
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
