"use client";

import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Library as LibraryIcon } from "lucide-react";
import { apiFetch } from "@/lib/api/client";
import { libraryResourceOptions } from "@/lib/actions/resourceActions";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import StatusPill from "@/components/ui/StatusPill";
import { AppList, AppListItem } from "@/components/ui/AppList";
import SectionCard from "@/components/ui/SectionCard";
import LibraryEditDialog from "@/components/LibraryEditDialog";
import type {
  LibraryForEdit,
  LibraryMember,
  LibraryInvite,
  UserSearchResult,
} from "@/components/LibraryEditDialog";
import styles from "./page.module.css";

interface Library {
  id: string;
  name: string;
  owner_user_id: string;
  is_default: boolean;
  role: string;
  created_at: string;
  updated_at: string;
}

export default function LibrariesPaneBody() {
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [newLibraryName, setNewLibraryName] = useState("");
  const [creating, setCreating] = useState(false);

  /* ---- Edit dialog state ---- */
  const [editLibrary, setEditLibrary] = useState<Library | null>(null);
  const [editMembers, setEditMembers] = useState<LibraryMember[]>([]);
  const [editInvites, setEditInvites] = useState<LibraryInvite[]>([]);

  const fetchLibraries = async () => {
    try {
      const libsResponse = await apiFetch<{ data: Library[] }>("/api/libraries");
      setLibraries(libsResponse.data);
      setError(null);
    } catch (err) {
      setError(
        toFeedback(err, {
          fallback: "Failed to load libraries",
        })
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLibraries();
  }, []);

  const handleCreateLibrary = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLibraryName.trim()) return;

    setCreating(true);
    try {
      await apiFetch("/api/libraries", {
        method: "POST",
        body: JSON.stringify({ name: newLibraryName.trim() }),
      });
      setNewLibraryName("");
      await fetchLibraries();
    } catch (err) {
      setError(
        toFeedback(err, {
          fallback: "Failed to create library",
        })
      );
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteLibrary = async (library: Library) => {
    if (!confirm(`Delete "${library.name}"? This cannot be undone.`)) return;

    try {
      await apiFetch(`/api/libraries/${library.id}`, {
        method: "DELETE",
      });
      await fetchLibraries();
    } catch (err) {
      setError(
        toFeedback(err, {
          fallback: "Failed to delete library",
        })
      );
    }
  };

  const handleOpenLibraryChat = useCallback(async (library: Library) => {
    try {
      const response = await apiFetch<{ data: { id: string; title: string } }>(
        "/api/conversations/resolve",
        {
          method: "POST",
          body: JSON.stringify({ type: "library", library_id: library.id }),
        }
      );
      const route = `/conversations/${response.data.id}`;
      if (!requestOpenInAppPane(route, { titleHint: response.data.title || library.name })) {
        window.location.assign(route);
      }
    } catch (err) {
      setError(
        toFeedback(err, {
          fallback: "Failed to open library chat",
        })
      );
    }
  }, []);

  /* ---- Edit dialog handlers ---- */

  const openEditDialog = useCallback(async (library: Library) => {
    setEditLibrary(library);
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
      setError(
        toFeedback(err, {
          fallback: "Failed to load library sharing",
        })
      );
    }
  }, []);

  const closeEditDialog = useCallback(() => {
    setEditLibrary(null);
    setEditMembers([]);
    setEditInvites([]);
  }, []);

  const handleRename = useCallback(
    async (name: string) => {
      if (!editLibrary) return;
      await apiFetch(`/api/libraries/${editLibrary.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      setEditLibrary((prev) => (prev ? { ...prev, name } : null));
      await fetchLibraries();
    },
    [editLibrary]
  );

  const handleUpdateMemberRole = useCallback(
    async (userId: string, role: string) => {
      if (!editLibrary) return;
      await apiFetch(`/api/libraries/${editLibrary.id}/members/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      setEditMembers((prev) =>
        prev.map((m) => (m.user_id === userId ? { ...m, role } : m))
      );
    },
    [editLibrary]
  );

  const handleRemoveMember = useCallback(
    async (userId: string) => {
      if (!editLibrary) return;
      await apiFetch(`/api/libraries/${editLibrary.id}/members/${userId}`, {
        method: "DELETE",
      });
      setEditMembers((prev) => prev.filter((m) => m.user_id !== userId));
    },
    [editLibrary]
  );

  const handleCreateInvite = useCallback(
    async (inviteeIdentifier: string, role: string) => {
      if (!editLibrary) return;
      // Determine if identifier looks like an email or a UUID
      const isEmail = inviteeIdentifier.includes("@");
      const resp = await apiFetch<{ data: LibraryInvite }>(
        `/api/libraries/${editLibrary.id}/invites`,
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
    [editLibrary]
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

  const handleRevokeInvite = useCallback(
    async (inviteId: string) => {
      await apiFetch(`/api/libraries/invites/${inviteId}`, {
        method: "DELETE",
      });
      setEditInvites((prev) =>
        prev.map((inv) =>
          inv.id === inviteId ? { ...inv, status: "revoked" } : inv
        )
      );
    },
    []
  );

  const handleDeleteFromDialog = useCallback(async () => {
    if (!editLibrary) return;
    if (!confirm(`Delete "${editLibrary.name}"? This cannot be undone.`))
      return;
    await apiFetch(`/api/libraries/${editLibrary.id}`, {
      method: "DELETE",
    });
    closeEditDialog();
    await fetchLibraries();
  }, [editLibrary, closeEditDialog]);

  /* ---- Edit dialog library data ---- */

  const editLibraryForDialog: LibraryForEdit | null = editLibrary
    ? {
        id: editLibrary.id,
        name: editLibrary.name,
        is_default: editLibrary.is_default,
        role: editLibrary.role,
        owner_user_id: editLibrary.owner_user_id,
      }
    : null;

  return (
    <>
      <SectionCard>
        <div className={styles.content}>
          <form className={styles.createForm} onSubmit={handleCreateLibrary}>
            <input
              type="text"
              value={newLibraryName}
              onChange={(e) => setNewLibraryName(e.target.value)}
              placeholder="New library name..."
              className={styles.input}
              disabled={creating}
            />
            <button
              type="submit"
              className={styles.createBtn}
              disabled={creating || !newLibraryName.trim()}
            >
              {creating ? "Creating..." : "Create"}
            </button>
          </form>

          {error && <FeedbackNotice {...error} />}

          {loading ? (
            <FeedbackNotice severity="info" title="Loading libraries..." />
          ) : libraries.length === 0 ? (
            <FeedbackNotice
              severity="neutral"
              title="No libraries yet."
              message="Create your first library above."
            />
          ) : (
            <AppList>
              {libraries.map((library) => (
                <AppListItem
                  key={library.id}
                  href={`/libraries/${library.id}`}
                  paneTitleHint={library.name}
                  icon={
                    library.is_default ? (
                      <FolderOpen size={18} />
                    ) : (
                      <LibraryIcon size={18} />
                    )
                  }
                  title={library.name}
                  meta={
                    library.is_default
                      ? `default media library · role ${library.role}`
                      : `mixed library · role ${library.role}`
                  }
                  trailing={
                    library.is_default ? (
                      <StatusPill variant="info">default</StatusPill>
                    ) : null
                  }
                  options={libraryResourceOptions({
                    library,
                    onOpenChat: () => void handleOpenLibraryChat(library),
                    onViewIntelligence: () => {
                      const route = `/libraries/${library.id}?view=intelligence`;
                      if (!requestOpenInAppPane(route, { titleHint: library.name })) {
                        window.location.assign(route);
                      }
                    },
                    onEdit: () => void openEditDialog(library),
                    onDelete: () => void handleDeleteLibrary(library),
                  })}
                />
              ))}
            </AppList>
          )}
        </div>
      </SectionCard>

      {editLibraryForDialog && (
        <LibraryEditDialog
          open={!!editLibrary}
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
