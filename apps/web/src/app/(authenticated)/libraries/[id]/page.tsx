"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import Pane from "@/components/Pane";
import PaneContainer from "@/components/PaneContainer";
import MediaKindIcon from "@/components/MediaKindIcon";
import StateMessage from "@/components/ui/StateMessage";
import { AppList, AppListItem } from "@/components/ui/AppList";
import LibraryEditDialog from "@/components/LibraryEditDialog";
import type {
  LibraryForEdit,
  LibraryMember,
  LibraryInvite,
  UserSearchResult,
} from "@/components/LibraryEditDialog";
import { usePaneParam, usePaneRouter, useSetPaneTitle } from "@/lib/panes/paneRuntime";
import styles from "./page.module.css";

interface Media {
  id: string;
  kind: string;
  title: string;
  canonical_source_url: string | null;
  processing_status: string;
  created_at: string;
  updated_at: string;
}

function formatDate(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "unknown date";
  return new Date(parsed).toLocaleDateString();
}

interface Library {
  id: string;
  name: string;
  is_default: boolean;
  role: string;
  owner_user_id: string;
}

export default function LibraryDetailPage() {
  const id = usePaneParam("id");
  if (!id) {
    throw new Error("library route requires an id");
  }
  const router = usePaneRouter();
  const [library, setLibrary] = useState<Library | null>(null);
  const [media, setMedia] = useState<Media[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useSetPaneTitle(library?.name ?? "Library");

  /* ---- Edit dialog state ---- */
  const [editOpen, setEditOpen] = useState(false);
  const [editMembers, setEditMembers] = useState<LibraryMember[]>([]);
  const [editInvites, setEditInvites] = useState<LibraryInvite[]>([]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [libraryResp, mediaResp] = await Promise.all([
          apiFetch<{ data: Library }>(`/api/libraries/${id}`),
          apiFetch<{ data: Media[] }>(`/api/libraries/${id}/media`),
        ]);
        setLibrary(libraryResp.data);
        setMedia(mediaResp.data);
        setError(null);
      } catch (err) {
        if (isApiError(err)) {
          if (err.status === 404) {
            router.push("/libraries");
            return;
          }
          setError(err.message);
        } else {
          setError("Failed to load library");
        }
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [id, router]);

  const handleRemoveMedia = async (mediaId: string) => {
    if (!confirm("Remove this media from the library?")) return;

    try {
      await apiFetch(`/api/libraries/${id}/media/${mediaId}`, {
        method: "DELETE",
      });
      setMedia(media.filter((m) => m.id !== mediaId));
    } catch (err) {
      if (isApiError(err)) {
        setError(err.message);
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

  /* ---- Edit dialog handlers ---- */

  const openEditDialog = useCallback(async () => {
    if (!library) return;
    setEditOpen(true);
    try {
      const [membersResp, invitesResp] = await Promise.all([
        library.role === "admin"
          ? apiFetch<{ data: LibraryMember[] }>(
              `/api/libraries/${library.id}/members`
            )
          : Promise.resolve({ data: [] as LibraryMember[] }),
        library.role === "admin"
          ? apiFetch<{ data: LibraryInvite[] }>(
              `/api/libraries/${library.id}/invites`
            )
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
        prev.map((m) => (m.user_id === userId ? { ...m, role } : m))
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
      setEditMembers((prev) => prev.filter((m) => m.user_id !== userId));
    },
    [library]
  );

  const handleCreateInvite = useCallback(
    async (inviteeIdentifier: string, role: string) => {
      if (!library) return;
      const isEmail = inviteeIdentifier.includes("@");
      const resp = await apiFetch<{ data: LibraryInvite }>(
        `/api/libraries/${library.id}/invites`,
        {
          method: "POST",
          body: JSON.stringify({
            ...(isEmail
              ? { invitee_email: inviteeIdentifier }
              : { invitee_user_id: inviteeIdentifier }),
            role,
          }),
        }
      );
      setEditInvites((prev) => [resp.data, ...prev]);
    },
    [library]
  );

  const handleSearchUsers = useCallback(
    async (query: string): Promise<UserSearchResult[]> => {
      const resp = await apiFetch<{ data: UserSearchResult[] }>(
        `/api/users/search?q=${encodeURIComponent(query)}`
      );
      return resp.data;
    },
    []
  );

  const handleRevokeInvite = useCallback(async (inviteId: string) => {
    await apiFetch(`/api/libraries/invites/${inviteId}`, {
      method: "DELETE",
    });
    setEditInvites((prev) =>
      prev.map((inv) =>
        inv.id === inviteId ? { ...inv, status: "revoked" } : inv
      )
    );
  }, []);

  const handleDeleteFromDialog = useCallback(async () => {
    if (!library) return;
    if (!confirm(`Delete "${library.name}"? This cannot be undone.`)) return;
    await apiFetch(`/api/libraries/${library.id}`, {
      method: "DELETE",
    });
    closeEditDialog();
    router.push("/libraries");
  }, [library, closeEditDialog, router]);

  const statusVariant = (status: string) => {
    if (status === "ready" || status === "ready_for_reading") return "success";
    if (status === "extracting" || status === "embedding") return "info";
    if (status === "pending") return "warning";
    if (status === "failed") return "danger";
    return "neutral";
  };

  if (loading) {
    return (
      <PaneContainer>
        <Pane title="Loading...">
          <StateMessage variant="loading">Loading library...</StateMessage>
        </Pane>
      </PaneContainer>
    );
  }

  if (!library) {
    return (
      <PaneContainer>
        <Pane title="Error">
          <StateMessage variant="error">{error || "Library not found"}</StateMessage>
        </Pane>
      </PaneContainer>
    );
  }

  const paneOptions = library.is_default
    ? []
    : [
        {
          id: "edit-library",
          label: "Edit library",
          onSelect: () => void openEditDialog(),
        },
        ...(library.role === "admin"
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

  const editLibraryForDialog: LibraryForEdit = {
    id: library.id,
    name: library.name,
    is_default: library.is_default,
    role: library.role,
    owner_user_id: library.owner_user_id,
  };

  return (
    <PaneContainer>
      <Pane title={library.name} options={paneOptions}>
        <div className={styles.content}>
          {error && <StateMessage variant="error">{error}</StateMessage>}

          {media.length === 0 ? (
            <StateMessage variant="empty">No media in this library yet.</StateMessage>
          ) : (
            <AppList>
              {media.map((item) => (
                <AppListItem
                  key={item.id}
                  href={`/media/${item.id}`}
                  icon={<MediaKindIcon kind={item.kind} />}
                  title={item.title}
                  paneTitleHint={item.title}
                  paneResourceRef={`media:${item.id}`}
                  status={statusVariant(item.processing_status)}
                  meta={[item.kind.replaceAll("_", " "), `Updated ${formatDate(item.updated_at)}`].join(" · ")}
                  options={
                    library.role === "admin"
                      ? [
                          {
                            id: "remove",
                            label: "Remove",
                            tone: "danger" as const,
                            onSelect: () => {
                              void handleRemoveMedia(item.id);
                            },
                          },
                        ]
                      : []
                  }
                />
              ))}
            </AppList>
          )}
        </div>
      </Pane>

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
    </PaneContainer>
  );
}
