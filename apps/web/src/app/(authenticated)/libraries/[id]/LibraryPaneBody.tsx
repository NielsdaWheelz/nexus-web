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
  canonical_source_url: string | null;
  processing_status: string;
  created_at: string;
  updated_at: string;
}

interface LibraryPodcastEntry {
  id: string;
  title: string;
  author: string | null;
  feed_url: string;
  website_url: string | null;
  image_url: string | null;
  unplayed_count: number;
  updated_at: string;
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

function formatDate(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "unknown date";
  return new Date(parsed).toLocaleDateString();
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
      if (entry.kind === "podcast" && entry.podcast) {
        await apiFetch(`/api/libraries/${id}/podcasts/${entry.podcast.id}`, {
          method: "DELETE",
        });
      }
      if (entry.kind === "media" && entry.media) {
        await apiFetch(`/api/libraries/${id}/media/${entry.media.id}`, {
          method: "DELETE",
        });
      }
      setEntries((prev) => prev.filter((candidate) => candidate.id !== entry.id));
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

                if (item.kind === "podcast" && item.podcast) {
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
                      {library.role === "admin" && (
                        <ActionMenu
                          options={[
                            {
                              id: "remove-from-library",
                              label: "Remove from library",
                              tone: "danger",
                              onSelect: () => {
                                void handleRemoveEntry(item);
                              },
                            },
                          ]}
                          className={styles.rowActionMenu}
                        />
                      )}
                    </div>
                  );
                }

                if (item.kind === "media" && item.media) {
                  const Icon = MEDIA_KIND_ICONS[item.media.kind] ?? Globe;
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
                          <span className={styles.mediaMeta}>
                            {[
                              item.media.kind.replaceAll("_", " "),
                              item.media.processing_status,
                              `Updated ${formatDate(item.media.updated_at)}`,
                            ].join(" · ")}
                          </span>
                        </a>
                      </div>
                      {library.role === "admin" && (
                        <ActionMenu
                          options={[
                            {
                              id: "remove-from-library",
                              label: "Remove from library",
                              tone: "danger",
                              onSelect: () => {
                                void handleRemoveEntry(item);
                              },
                            },
                          ]}
                          className={styles.rowActionMenu}
                        />
                      )}
                    </div>
                  );
                }

                return null;
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
