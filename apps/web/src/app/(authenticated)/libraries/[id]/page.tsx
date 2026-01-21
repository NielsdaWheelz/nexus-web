"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch, isApiError } from "@/lib/api/client";
import Pane from "@/components/Pane";
import PaneContainer from "@/components/PaneContainer";
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

export default function LibraryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [library, setLibrary] = useState<Library | null>(null);
  const [media, setMedia] = useState<Media[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [libs, mediaList] = await Promise.all([
          apiFetch<Library[]>("/api/libraries"),
          apiFetch<Media[]>(`/api/libraries/${id}/media`),
        ]);
        const lib = libs.find((l) => l.id === id);
        if (!lib) {
          setError("Library not found");
          return;
        }
        setLibrary(lib);
        setNewName(lib.name);
        setMedia(mediaList);
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

  const getKindIcon = (kind: string) => {
    switch (kind) {
      case "web_article":
        return "📄";
      case "epub":
        return "📖";
      case "pdf":
        return "📕";
      case "podcast_episode":
        return "🎙️";
      case "video":
        return "🎬";
      default:
        return "📄";
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "ready":
      case "ready_for_reading":
        return styles.statusReady;
      case "pending":
      case "extracting":
      case "embedding":
        return styles.statusPending;
      case "failed":
        return styles.statusFailed;
      default:
        return "";
    }
  };

  if (loading) {
    return (
      <PaneContainer>
        <Pane title="Loading...">
          <div className={styles.loading}>Loading library...</div>
        </Pane>
      </PaneContainer>
    );
  }

  if (!library) {
    return (
      <PaneContainer>
        <Pane title="Error">
          <div className={styles.error}>{error || "Library not found"}</div>
        </Pane>
      </PaneContainer>
    );
  }

  return (
    <PaneContainer>
      <Pane title={library.name}>
        <div className={styles.content}>
          <div className={styles.header}>
            <Link href="/libraries" className={styles.backLink}>
              ← Back to Libraries
            </Link>

            {!library.is_default && library.role === "admin" && (
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
            )}
          </div>

          {error && <div className={styles.error}>{error}</div>}

          {media.length === 0 ? (
            <div className={styles.empty}>
              <p>No media in this library yet.</p>
            </div>
          ) : (
            <ul className={styles.list}>
              {media.map((item) => (
                <li key={item.id} className={styles.item}>
                  <Link href={`/media/${item.id}`} className={styles.link}>
                    <span className={styles.icon}>{getKindIcon(item.kind)}</span>
                    <span className={styles.title}>{item.title}</span>
                    <span
                      className={`${styles.status} ${getStatusColor(item.processing_status)}`}
                    >
                      {item.processing_status}
                    </span>
                  </Link>
                  {library.role === "admin" && (
                    <button
                      className={styles.removeBtn}
                      onClick={() => handleRemoveMedia(item.id)}
                      aria-label={`Remove ${item.title}`}
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Pane>
    </PaneContainer>
  );
}
