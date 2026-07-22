"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { createPortal } from "react-dom";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import LibraryColorDot from "@/components/LibraryColorDot";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import type { LibraryTargetPickerItem } from "@/lib/media/mediaLibraries";
import { useAnchoredPosition } from "@/lib/ui/useAnchoredPosition";
import { useDismissOnOutsideOrEscape } from "@/lib/ui/useDismissOnOutsideOrEscape";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import styles from "./LibraryMembershipPanel.module.css";

interface LibraryMembershipPanelProps {
  open: boolean;
  title: string;
  anchorEl: HTMLElement | null;
  returnFocusFallback?: () => HTMLElement | null;
  libraries: LibraryTargetPickerItem[];
  loading?: boolean;
  busy?: boolean;
  error?: string | FeedbackContent | null;
  emptyMessage?: string;
  onClose: () => void;
  onRetry?: () => void;
  onAddToLibrary: (libraryId: string) => void;
  onRemoveFromLibrary: (libraryId: string) => void;
}

export default function LibraryMembershipPanel({
  open,
  title,
  anchorEl,
  returnFocusFallback,
  libraries,
  loading = false,
  busy = false,
  error = null,
  emptyMessage = "No libraries found.",
  onClose,
  onRetry,
  onAddToLibrary,
  onRemoveFromLibrary,
}: LibraryMembershipPanelProps) {
  const isMobile = useIsMobileViewport();
  const [query, setQuery] = useState("");
  const {
    ref: panelRef,
    style: panelStyle,
    anchorRect,
  } = useAnchoredPosition(anchorEl, {
    enabled: open && !isMobile,
    placement: "below",
    align: "start",
    gap: 6,
  });
  const inputRef = useRef<HTMLInputElement>(null);

  const filteredLibraries = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      return libraries;
    }
    return libraries.filter((library) =>
      library.name.toLowerCase().includes(trimmed),
    );
  }, [libraries, query]);

  const restoreAnchorFocus = useCallback(() => {
    requestAnimationFrame(() => {
      const anchorDisabled =
        anchorEl instanceof HTMLButtonElement && anchorEl.disabled;
      if (
        anchorEl?.isConnected &&
        !anchorDisabled &&
        anchorEl.getAttribute("aria-disabled") !== "true" &&
        !anchorEl.closest("[inert]")
      ) {
        anchorEl.focus();
        if (document.activeElement === anchorEl) return;
      }
      const fallback = returnFocusFallback?.() ?? null;
      if (fallback?.isConnected && !fallback.closest("[inert]")) {
        fallback.focus();
      }
    });
  }, [anchorEl, returnFocusFallback]);

  const handleClose = useCallback(() => {
    onClose();
    restoreAnchorFocus();
  }, [onClose, restoreAnchorFocus]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [open]);

  const anchorRef = useMemo(() => ({ current: anchorEl }), [anchorEl]);

  useDismissOnOutsideOrEscape({
    enabled: open && !isMobile,
    refs: [panelRef, anchorRef],
    onDismiss: handleClose,
  });

  if (!open) {
    return null;
  }

  const content = (
    <div className={styles.content}>
      <div className={styles.searchRow}>
        <Input
          ref={inputRef}
          type="search"
          value={query}
          className={styles.searchInputField}
          placeholder="Search libraries..."
          aria-label="Search libraries"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {typeof error === "string" ? (
        <div className={styles.errorRow}>
          <div className={styles.error}>{error}</div>
          {onRetry ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={onRetry}
              disabled={busy}
            >
              Retry
            </Button>
          ) : null}
        </div>
      ) : error ? (
        <div className={styles.errorRow}>
          <FeedbackNotice feedback={error} />
          {onRetry ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={onRetry}
              disabled={busy}
            >
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className={styles.list}>
        {loading ? (
          <div className={styles.emptyState}>Loading libraries...</div>
        ) : filteredLibraries.length === 0 ? (
          <div className={styles.emptyState}>{emptyMessage}</div>
        ) : (
          filteredLibraries.map((library) => {
            const rowDisabled =
              busy ||
              (library.isInLibrary ? !library.canRemove : !library.canAdd);
            return (
              <button
                key={library.id}
                type="button"
                disabled={rowDisabled}
                className={styles.item}
                onClick={(event) => {
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
                    <LibraryColorDot color={library.color} />
                    {library.name}
                  </span>
                  <span className={styles.itemMeta}>
                    {library.isInLibrary
                      ? "Remove from this library"
                      : "Add to library"}
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

  if (isMobile) {
    return (
      <Dialog
        open={open}
        onClose={handleClose}
        title={title}
        returnFocusTo={() => anchorEl}
        returnFocusFallback={returnFocusFallback}
      >
        {content}
      </Dialog>
    );
  }

  return createPortal(
    <div
      ref={panelRef}
      className={styles.panel}
      role="dialog"
      aria-label={title}
      style={{ ...panelStyle, width: Math.max(anchorRect?.width ?? 0, 320) }}
    >
      <div className={styles.header}>
        <h2 className={styles.title}>{title}</h2>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          onClick={handleClose}
          aria-label="Close dialog"
        >
          <X size={16} />
        </Button>
      </div>
      {content}
    </div>,
    document.body,
  );
}
