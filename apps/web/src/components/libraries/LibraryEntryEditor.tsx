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
import type { LibraryPlacementOption } from "@/lib/libraries/libraryPlacement";
import styles from "./LibraryEntryEditor.module.css";

export interface LibraryEntryEditorProps {
  libraries: readonly LibraryPlacementOption[];
  loading?: boolean;
  busy?: boolean;
  busyLibraryId?: string | null;
  error?: string | FeedbackContent | null;
  emptyMessage?: string;
  onRetry?: () => void;
  onAddToLibrary: (libraryId: string) => void;
  onRemoveFromLibrary: (libraryId: string) => void;
}

export default function LibraryEntryEditor({
  libraries,
  loading = false,
  busy = false,
  busyLibraryId = null,
  error = null,
  emptyMessage = "No additional libraries available.",
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
  const isBusy = busy || busyLibraryId !== null;

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
              disabled={isBusy}
              onClick={onRetry}
            >
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}

      {loading ? (
        <p className={styles.empty} role="status">
          {libraries.length === 0
            ? "Loading libraries…"
            : "Updating libraries…"}
        </p>
      ) : null}

      <div className={styles.list}>
        {!loading && !error && libraries.length === 0 ? (
          <p className={styles.empty}>{emptyMessage}</p>
        ) : libraries.length > 0 && filteredLibraries.length === 0 ? (
          <p className={styles.empty}>No matching libraries.</p>
        ) : (
          filteredLibraries.map((library) => {
            const actionable = library.isInLibrary
              ? library.canRemove
              : library.canAdd;
            const rowBusy = busyLibraryId === library.id;
            const disabled = !actionable || (isBusy && !rowBusy);
            return (
              <button
                key={library.id}
                type="button"
                className={styles.item}
                disabled={disabled}
                aria-label={library.name}
                aria-pressed={library.isInLibrary}
                aria-busy={rowBusy || undefined}
                aria-disabled={rowBusy || undefined}
                onClick={() => {
                  if (isBusy || !actionable) return;
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
                  <span className={styles.itemMeta} aria-hidden="true">
                    {!actionable
                      ? "You can’t change this library."
                      : library.isInLibrary
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
