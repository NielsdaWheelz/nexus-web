"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Check, ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";
import styles from "./LibraryTargetPicker.module.css";

export interface LibraryTargetPickerItem {
  id: string;
  name: string;
  color: string | null;
  isInLibrary: boolean;
  canAdd: boolean;
  canRemove: boolean;
}

interface LibraryTargetPickerProps {
  label: string;
  libraries: LibraryTargetPickerItem[];
  loading?: boolean;
  disabled?: boolean;
  emptyMessage?: string;
  allowNoLibrary?: boolean;
  noLibraryLabel?: string;
  selectedLibraryId?: string | null;
  onOpen?: () => void;
  onSelectLibrary?: (libraryId: string | null) => void;
}

export default function LibraryTargetPicker({
  label,
  libraries,
  loading = false,
  disabled = false,
  emptyMessage = "No libraries found.",
  allowNoLibrary = false,
  noLibraryLabel = "No library",
  selectedLibraryId = null,
  onOpen,
  onSelectLibrary,
}: LibraryTargetPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [panelStyle, setPanelStyle] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const selectedLibraryName =
    libraries.find((library) => library.id === selectedLibraryId)?.name ?? null;

  const filteredLibraries = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      return libraries;
    }
    return libraries.filter((library) =>
      library.name.toLowerCase().includes(trimmed)
    );
  }, [libraries, query]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const updatePanelStyle = () => {
      if (!buttonRef.current) {
        return;
      }
      const rect = buttonRef.current.getBoundingClientRect();
      const width = Math.max(rect.width, 260);
      const maxLeft = window.innerWidth - width - 8;
      setPanelStyle({
        top: rect.bottom + 6,
        left: Math.max(8, Math.min(rect.left, maxLeft)),
        width,
      });
    };

    updatePanelStyle();
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        panelRef.current?.contains(target) ||
        buttonRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
      setPanelStyle(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      setOpen(false);
      setPanelStyle(null);
      requestAnimationFrame(() => {
        buttonRef.current?.focus();
      });
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
  }, [open]);

  const triggerText = selectedLibraryName ?? label;

  const panel =
    open && panelStyle
      ? createPortal(
          <div
            ref={panelRef}
            id={panelId}
            className={styles.panel}
            role="dialog"
            aria-label={label}
            style={{
              position: "fixed",
              top: `${panelStyle.top}px`,
              left: `${panelStyle.left}px`,
              width: `${panelStyle.width}px`,
            }}
          >
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

            <div className={styles.list} role="listbox" aria-label={label}>
              {allowNoLibrary ? (
                <div
                  role="option"
                  tabIndex={disabled ? -1 : 0}
                  className={styles.item}
                  aria-selected={selectedLibraryId === null}
                  aria-disabled={disabled || undefined}
                  onClick={(event) => {
                    if (disabled) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    onSelectLibrary?.(null);
                    setOpen(false);
                    setPanelStyle(null);
                  }}
                  onKeyDown={(event) => {
                    if (disabled) {
                      return;
                    }
                    if (event.key !== "Enter" && event.key !== " ") {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    onSelectLibrary?.(null);
                    setOpen(false);
                    setPanelStyle(null);
                  }}
                >
                  <span className={styles.itemText}>
                    <span className={styles.itemName}>{noLibraryLabel}</span>
                  </span>
                  {selectedLibraryId === null ? (
                    <Check size={16} aria-hidden="true" />
                  ) : null}
                </div>
              ) : null}

              {loading ? (
                <div className={styles.emptyState}>Loading libraries...</div>
              ) : filteredLibraries.length === 0 ? (
                <div className={styles.emptyState}>{emptyMessage}</div>
              ) : (
                filteredLibraries.map((library) => (
                  <div
                    key={library.id}
                    role="option"
                    tabIndex={disabled ? -1 : 0}
                    className={styles.item}
                    aria-selected={selectedLibraryId === library.id}
                    aria-disabled={disabled || undefined}
                    onClick={(event) => {
                      if (disabled) {
                        return;
                      }
                      event.preventDefault();
                      event.stopPropagation();
                      onSelectLibrary?.(library.id);
                      setOpen(false);
                      setPanelStyle(null);
                    }}
                    onKeyDown={(event) => {
                      if (disabled) {
                        return;
                      }
                      if (event.key !== "Enter" && event.key !== " ") {
                        return;
                      }
                      event.preventDefault();
                      event.stopPropagation();
                      onSelectLibrary?.(library.id);
                      setOpen(false);
                      setPanelStyle(null);
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
                    </span>
                    {selectedLibraryId === library.id ? (
                      <Check size={16} aria-hidden="true" />
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        disabled={disabled}
        onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
          event.preventDefault();
          event.stopPropagation();
          if (!open) {
            onOpen?.();
            setQuery("");
          }
          setOpen((current) => !current);
        }}
      >
        <span className={styles.triggerLabel}>{triggerText}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {panel}
    </>
  );
}
