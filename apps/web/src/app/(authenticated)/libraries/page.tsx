"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch, isApiError } from "@/lib/api/client";
import Pane from "@/components/Pane";
import PaneContainer from "@/components/PaneContainer";
import FileUpload from "@/components/FileUpload";
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

interface MeResponse {
  user_id: string;
  default_library_id: string;
}

export default function LibrariesPage() {
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newLibraryName, setNewLibraryName] = useState("");
  const [creating, setCreating] = useState(false);
  const [viewerUserId, setViewerUserId] = useState<string | null>(null);

  const fetchLibraries = async () => {
    try {
      const [libsResponse, me] = await Promise.all([
        apiFetch<{ data: Library[] }>("/api/libraries"),
        apiFetch<{ data: MeResponse }>("/api/me"),
      ]);
      setLibraries(libsResponse.data);
      setViewerUserId(me.data.user_id);
      setError(null);
    } catch (err) {
      if (isApiError(err)) {
        setError(err.message);
      } else {
        setError("Failed to load libraries");
      }
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
      if (isApiError(err)) {
        setError(err.message);
      }
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
      if (isApiError(err)) {
        setError(err.message);
      }
    }
  };

  return (
    <PaneContainer>
      <Pane title="Libraries">
        <div className={styles.content}>
          {/* Create library form */}
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

          {error && <div className={styles.error}>{error}</div>}

          {loading ? (
            <div className={styles.loading}>Loading libraries...</div>
          ) : libraries.length === 0 ? (
            <div className={styles.empty}>
              <p>No libraries yet.</p>
              <p>Create your first library above!</p>
            </div>
          ) : (
            <ul className={styles.list}>
              {libraries.map((library) => (
                <li key={library.id} className={styles.item}>
                  <Link
                    href={`/libraries/${library.id}`}
                    className={styles.link}
                  >
                    <span className={styles.icon}>
                      {library.is_default ? "📁" : "📚"}
                    </span>
                    <span className={styles.name}>{library.name}</span>
                    {library.is_default && (
                      <span className={styles.badge}>Default</span>
                    )}
                  </Link>
                  {!library.is_default && viewerUserId && library.owner_user_id === viewerUserId && (
                    <button
                      className={styles.deleteBtn}
                      onClick={() => handleDeleteLibrary(library)}
                      aria-label={`Delete ${library.name}`}
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
      <Pane title="Upload">
        <div className={styles.uploadContent}>
          <FileUpload />
        </div>
      </Pane>
    </PaneContainer>
  );
}
