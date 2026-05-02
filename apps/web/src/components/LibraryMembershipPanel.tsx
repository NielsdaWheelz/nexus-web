"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Check, X } from "lucide-react";
import { createPortal } from "react-dom";
import Dialog from "@/components/ui/Dialog";
import type { LibraryTargetPickerItem } from "@/components/LibraryTargetPicker";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import styles from "./LibraryMembershipPanel.module.css";

interface LibraryMembershipPanelProps {
  open: boolean;
  title: string;
  anchorEl: HTMLElement | null;
  libraries: LibraryTargetPickerItem[];
  loading?: boolean;
  busy?: boolean;
  error?: string | null;
  emptyMessage?: string;
  onClose: () => void;
  onAddToLibrary: (libraryId: string) => void;
  onRemoveFromLibrary: (libraryId: string) => void;
}

export default function LibraryMembershipPanel({
  open,
  title,
  anchorEl,
  libraries,
  loading = false,
  busy = false,
  error = null,
  emptyMessage = "No libraries found.",
  onClose,
  onAddToLibrary,
  onRemoveFromLibrary,
}: LibraryMembershipPanelProps) {
  const isMobile = useIsMobileViewport();
  const [query, setQuery] = useState("");
  const [panelStyle, setPanelStyle] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filteredLibraries = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      return libraries;
    }
    return libraries.filter((library) =>
      library.name.toLowerCase().includes(trimmed)
    );
  }, [libraries, query]);

  const restoreAnchorFocus = useCallback(() => {
    if (!anchorEl || !anchorEl.isConnected) {
      return;
    }
    requestAnimationFrame(() => {
      anchorEl.focus();
    });
  }, [anchorEl]);

  const handleClose = useCallback(() => {
    onClose();
    restoreAnchorFocus();
  }, [onClose, restoreAnchorFocus]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setPanelStyle(null);
      return;
    }
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [open]);

  useEffect(() => {
    if (!open || isMobile) {
      return;
    }

    const updatePanelStyle = () => {
      if (!anchorEl) {
        return;
      }
      const rect = anchorEl.getBoundingClientRect();
      const width = Math.max(rect.width, 320);
      const maxLeft = window.innerWidth - width - 8;
      setPanelStyle({
        top: rect.bottom + 6,
        left: Math.max(8, Math.min(rect.left, maxLeft)),
        width,
      });
    };

    updatePanelStyle();

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        panelRef.current?.contains(target) ||
        anchorEl?.contains(target)
      ) {
        return;
      }
      handleClose();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      handleClose();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updatePanelStyle);
    window.addEventListener("scroll", updatePanelStyle, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updatePanelStyle);
      window.removeEventListener("scroll", updatePanelStyle, true);
    };
  }, [anchorEl, handleClose, isMobile, open]);

  if (!open) {
    return null;
  }

  const content = (
    <div className={styles.content}>
      <div className={styles.searchRow}>
        <input
          ref={inputRef}
          type="search"
          value={query}
          className={styles.searchInput}
          placeholder="Search libraries..."
          aria-label="Search libraries"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.list}>
        {loading ? (
          <div className={styles.emptyState}>Loading libraries...</div>
        ) : filteredLibraries.length === 0 ? (
          <div className={styles.emptyState}>{emptyMessage}</div>
        ) : (
          filteredLibraries.map((library) => {
            const rowDisabled = busy || (library.isInLibrary ? !library.canRemove : !library.canAdd);
            return (
              <button
                key={library.id}
                type="button"
                className={styles.item}
                disabled={rowDisabled}
                onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (library.isInLibrary) {
                    onRemoveFromLibrary(library.id);
                    return;
                  }
                  onAddToLibrary(library.id);
                }}
              >
                <span className={styles.itemText}>
                  <span className={styles.itemName}>
                    {library.color ? (
                      <span
                        className={styles.colorDot}
                        style={{ backgroundColor: library.color }}
                        aria-hidden="true"
                      />
                    ) : null}
                    {library.name}
                  </span>
                  <span className={styles.itemMeta}>
                    {library.isInLibrary ? "Remove from this library" : "Add to library"}
                  </span>
                </span>
                {library.isInLibrary ? <Check size={16} aria-hidden="true" /> : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <Dialog open={open} onClose={handleClose} title={title}>
        {content}
      </Dialog>
    );
  }

  if (!panelStyle) {
    return null;
  }

  return createPortal(
    <div
      ref={panelRef}
      className={styles.panel}
      role="dialog"
      aria-label={title}
      style={{
        position: "fixed",
        top: `${panelStyle.top}px`,
        left: `${panelStyle.left}px`,
        width: `${panelStyle.width}px`,
      }}
    >
      <div className={styles.header}>
        <h2 className={styles.title}>{title}</h2>
        <button
          type="button"
          className={styles.closeButton}
          onClick={handleClose}
          aria-label="Close dialog"
        >
          <X size={16} />
        </button>
      </div>
      {content}
    </div>,
    document.body
  );
}
