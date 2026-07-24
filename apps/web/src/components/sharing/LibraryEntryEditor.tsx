"use client";

import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import LibraryColorDot from "@/components/LibraryColorDot";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import type { LibraryTargetPickerItem } from "@/lib/media/mediaLibraries";
import styles from "./LibraryEntryEditor.module.css";

export interface LibraryEntryEditorProps {
  libraries: LibraryTargetPickerItem[];
  loading?: boolean;
  busy?: boolean;
  error?: string | FeedbackContent | null;
  emptyMessage?: string;
  onRetry?: () => void;
  onAddToLibrary: (libraryId: string) => void;
  onRemoveFromLibrary: (libraryId: string) => void;
}

/**
 * Edits where an existing media item or podcast is filed. This component owns
 * no modal state, so Share can embed it without creating a nested overlay.
 */
export default function LibraryEntryEditor({
  libraries,
  loading = false,
  busy = false,
  error = null,
  emptyMessage = "No libraries found.",
  onRetry,
  onAddToLibrary,
  onRemoveFromLibrary,
}: LibraryEntryEditorProps) {
  const [query, setQuery] = useState("");
  const filteredLibraries = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return libraries;
    return libraries.filter((library) =>
      library.name.toLocaleLowerCase().includes(normalized),
    );
  }, [libraries, query]);

  return (
    <div className={styles.content}>
      <Input
        type="search"
        value={query}
        placeholder="Search libraries…"
        aria-label="Search libraries"
        onChange={(event) => setQuery(event.target.value)}
      />

      {error ? (
        <div className={styles.feedback}>
          {typeof error === "string" ? (
            <p role="alert">{error}</p>
          ) : (
            <FeedbackNotice feedback={error} />
          )}
          {onRetry ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={onRetry}
            >
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className={styles.list}>
        {loading ? (
          <p className={styles.empty} role="status">
            Loading libraries…
          </p>
        ) : filteredLibraries.length === 0 ? (
          <p className={styles.empty}>{emptyMessage}</p>
        ) : (
          filteredLibraries.map((library) => {
            const disabled =
              busy ||
              (library.isInLibrary ? !library.canRemove : !library.canAdd);
            return (
              <button
                key={library.id}
                type="button"
                className={styles.item}
                disabled={disabled}
                aria-pressed={library.isInLibrary}
                onClick={() => {
                  if (library.isInLibrary) {
                    onRemoveFromLibrary(library.id);
                  } else {
                    onAddToLibrary(library.id);
                  }
                }}
              >
                <span className={styles.itemText}>
                  <span className={styles.itemName}>
                    <LibraryColorDot color={library.color} />
                    {library.name}
                  </span>
                  <span className={styles.itemMeta}>
                    {library.isInLibrary
                      ? "Included in this library"
                      : "Not in this library"}
                  </span>
                </span>
                {library.isInLibrary ? (
                  <Check size={16} aria-hidden="true" />
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
