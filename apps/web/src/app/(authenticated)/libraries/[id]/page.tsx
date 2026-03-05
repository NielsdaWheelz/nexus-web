"use client";

import { useEffect, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import Pane from "@/components/Pane";
import PaneContainer from "@/components/PaneContainer";
import MediaKindIcon from "@/components/MediaKindIcon";
import StateMessage from "@/components/ui/StateMessage";
import StatusPill from "@/components/ui/StatusPill";
import { AppList, AppListItem } from "@/components/ui/AppList";
import { usePaneParam, usePaneRouter } from "@/lib/panes/paneRuntime";
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

interface Library {
  id: string;
  name: string;
  is_default: boolean;
  role: string;
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
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [libsResp, mediaResp] = await Promise.all([
          apiFetch<{ data: Library[] }>("/api/libraries"),
          apiFetch<{ data: Media[] }>(`/api/libraries/${id}/media`),
        ]);
        const lib = libsResp.data.find((l) => l.id === id);
        if (!lib) {
          setError("Library not found");
          return;
        }
        setLibrary(lib);
        setNewName(lib.name);
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

  const handleRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !library) return;

    setRenaming(true);
    try {
      await apiFetch(`/api/libraries/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: newName.trim() }),
      });
      setLibrary({ ...library, name: newName.trim() });
    } catch (err) {
      if (isApiError(err)) {
        setError(err.message);
      }
    } finally {
      setRenaming(false);
    }
  };

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

  return (
    <PaneContainer>
      <Pane
        title={library.name}
        headerActions={
          !library.is_default && library.role === "admin" ? (
            <form className={styles.renameForm} onSubmit={handleRename}>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className={styles.input}
                disabled={renaming}
              />
              <button
                type="submit"
                className={styles.renameBtn}
                disabled={renaming || newName === library.name}
              >
                {renaming ? "Saving..." : "Rename"}
              </button>
            </form>
          ) : null
        }
        options={
          !library.is_default && library.role === "admin"
            ? [
                {
                  id: "delete-library",
                  label: "Delete library",
                  tone: "danger",
                  onSelect: () => {
                    void handleDeleteLibrary();
                  },
                },
              ]
            : []
        }
      >
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
                  description={item.kind.replaceAll("_", " ")}
                  trailing={
                    <StatusPill variant={statusVariant(item.processing_status)}>
                      {item.processing_status.replaceAll("_", " ")}
                    </StatusPill>
                  }
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
    </PaneContainer>
  );
}
