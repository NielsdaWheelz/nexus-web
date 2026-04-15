"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CircleCheck,
  CircleX,
  FileText,
  Link,
  Plus,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import { OPEN_UPLOAD_EVENT } from "@/components/CommandPalette";
import { getFocusableElements } from "@/lib/ui/getFocusableElements";
import { useFocusTrap } from "@/lib/ui/useFocusTrap";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import {
  addMediaFromUrl,
  getFileUploadError,
  uploadIngestFile,
} from "@/lib/media/ingestionClient";
import styles from "./IngestionTray.module.css";

type QueueItem = {
  id: number;
  source: "file" | "url";
  label: string;
  file?: File;
  url?: string;
  status: "queued" | "working" | "success" | "error";
  error?: string;
  mediaId?: string;
  duplicate?: boolean;
  autoOpen: boolean;
};

const MAX_ACTIVE_UPLOADS = 2;

function extractUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>"']+/g) ?? [];
  const unique: string[] = [];
  for (const raw of found) {
    const cleaned = raw.replace(/[),.;!?]+$/g, "");
    try {
      const parsed = new URL(cleaned);
      if (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        !unique.includes(cleaned)
      ) {
        unique.push(cleaned);
      }
    } catch {
      // Ignore URL-looking text that the URL parser rejects.
    }
  }
  return unique;
}

function eventTargetAcceptsText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return Boolean(target.closest("input, textarea, select, [contenteditable]"));
}

function dragHasSupportedData(event: DragEvent): boolean {
  const types = Array.from(event.dataTransfer?.types ?? []);
  return types.includes("Files") || types.includes("text/uri-list");
}

export default function IngestionTray() {
  const [open, setOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [urlText, setUrlText] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const nextIdRef = useRef(1);
  const activeIdsRef = useRef<Set<number>>(new Set());
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const trayRef = useRef<HTMLElement>(null);
  const isMobile = useIsMobileViewport();

  const enqueueFiles = useCallback((files: File[], autoOpenSingle: boolean) => {
    if (files.length === 0) return;
    setOpen(true);
    setQueue((current) => [
      ...current,
      ...files.map((file) => {
        const error = getFileUploadError(file);
        return {
          id: nextIdRef.current++,
          source: "file" as const,
          label: file.name,
          file,
          status: error ? ("error" as const) : ("queued" as const),
          error: error ?? undefined,
          autoOpen: autoOpenSingle && files.length === 1,
        };
      }),
    ]);
  }, []);

  const enqueueUrls = useCallback((urls: string[], autoOpenSingle: boolean) => {
    if (urls.length === 0) return;
    setOpen(true);
    setQueue((current) => [
      ...current,
      ...urls.map((url) => ({
        id: nextIdRef.current++,
        source: "url" as const,
        label: url,
        url,
        status: "queued" as const,
        autoOpen: autoOpenSingle && urls.length === 1,
      })),
    ]);
  }, []);

  const startItem = useCallback((item: QueueItem) => {
    if (activeIdsRef.current.has(item.id)) return;
    activeIdsRef.current.add(item.id);
    setQueue((current) =>
      current.map((row) => (row.id === item.id ? { ...row, status: "working", error: undefined } : row))
    );

    void (async () => {
      try {
        let result: { mediaId: string; duplicate: boolean };
        if (item.source === "file") {
          if (!item.file) throw new Error("Missing file.");
          result = await uploadIngestFile(item.file);
        } else {
          if (!item.url) throw new Error("Missing URL.");
          result = await addMediaFromUrl(item.url);
        }

        setQueue((current) =>
          current.map((row) =>
            row.id === item.id
              ? {
                  ...row,
                  status: "success",
                  mediaId: result.mediaId,
                  duplicate: result.duplicate,
                }
              : row
          )
        );

        if (item.autoOpen) {
          setOpen(false);
          requestOpenInAppPane(
            result.duplicate ? `/media/${result.mediaId}?duplicate=true` : `/media/${result.mediaId}`
          );
        }
      } catch (error) {
        setQueue((current) =>
          current.map((row) =>
            row.id === item.id
              ? {
                  ...row,
                  status: "error",
                  error: error instanceof Error ? error.message : "Failed to add item.",
                }
              : row
          )
        );
      } finally {
        activeIdsRef.current.delete(item.id);
      }
    })();
  }, []);

  useEffect(() => {
    const available = MAX_ACTIVE_UPLOADS - activeIdsRef.current.size;
    if (available <= 0) return;
    for (const item of queue.filter((row) => row.status === "queued").slice(0, available)) {
      startItem(item);
    }
  }, [queue, startItem]);

  useEffect(() => {
    const openHandler = () => setOpen(true);
    window.addEventListener(OPEN_UPLOAD_EVENT, openHandler);
    return () => window.removeEventListener(OPEN_UPLOAD_EVENT, openHandler);
  }, []);

  useEffect(() => {
    const onDragEnter = (event: DragEvent) => {
      if (!dragHasSupportedData(event)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setDragActive(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!dragHasSupportedData(event)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
      setDragActive(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (!dragHasSupportedData(event)) return;
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setDragActive(false);
      }
    };
    const onDrop = (event: DragEvent) => {
      const transfer = event.dataTransfer;
      if (!transfer) return;
      const files = Array.from(transfer.files ?? []);
      const uriList = transfer.getData("text/uri-list");
      const plainText = transfer.getData("text/plain");
      const urls = extractUrls(uriList || plainText);
      if (files.length === 0 && urls.length === 0) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setDragActive(false);
      enqueueFiles(files, false);
      enqueueUrls(urls, false);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [enqueueFiles, enqueueUrls]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (eventTargetAcceptsText(event.target)) return;
      const urls = extractUrls(event.clipboardData?.getData("text/plain") ?? "");
      if (urls.length === 0) return;
      event.preventDefault();
      enqueueUrls(urls, false);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [enqueueUrls]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    if (!isMobile || !open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobile, open]);

  useFocusTrap(trayRef, isMobile && open);

  useEffect(() => {
    if (!isMobile || !open || !trayRef.current) return;
    const firstFocusable = getFocusableElements(trayRef.current)[0];
    (firstFocusable ?? trayRef.current).focus();
  }, [isMobile, open]);

  const submitUrls = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const urls = extractUrls(urlText);
      if (urls.length === 0) {
        setUrlError("Paste one or more http:// or https:// URLs.");
        return;
      }
      setUrlError(null);
      setUrlText("");
      enqueueUrls(urls, true);
    },
    [enqueueUrls, urlText]
  );

  const retryItem = useCallback((item: QueueItem) => {
    const error = item.source === "file" && item.file ? getFileUploadError(item.file) : null;
    setQueue((current) =>
      current.map((row) =>
        row.id === item.id
          ? {
              ...row,
              status: error ? "error" : "queued",
              error: error ?? undefined,
              mediaId: undefined,
              duplicate: undefined,
            }
          : row
      )
    );
  }, []);

  const removeItem = useCallback((id: number) => {
    setQueue((current) => current.filter((row) => row.id !== id));
  }, []);

  const tray = open ? (
    <div className={isMobile ? styles.mobileBackdrop : styles.desktopLayer} onClick={() => setOpen(false)}>
      <section
        ref={trayRef}
        className={isMobile ? styles.mobileSheet : styles.panel}
        role="dialog"
        aria-modal={isMobile ? "true" : "false"}
        aria-label="Add content"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        {isMobile && <div className={styles.handle} aria-hidden="true" />}
        <header className={styles.header}>
          <div>
            <h2>Add content</h2>
            <p>Upload PDFs and EPUBs, or paste article and video URLs.</p>
          </div>
          <button type="button" className={styles.iconButton} onClick={() => setOpen(false)} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.body}>
          <button type="button" className={styles.dropzone} onClick={() => fileInputRef.current?.click()}>
            <Upload size={22} aria-hidden="true" />
            <span>Upload file</span>
            <small>PDF up to 100 MB, EPUB up to 50 MB. Select or drop many at once.</small>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.epub,application/pdf,application/epub+zip"
            className={styles.fileInput}
            aria-label="Upload file"
            onChange={(event) => {
              enqueueFiles(Array.from(event.target.files ?? []), true);
              event.target.value = "";
            }}
          />

          <form className={styles.urlForm} onSubmit={submitUrls}>
            <label htmlFor="ingestion-url-input">URLs</label>
            <textarea
              id="ingestion-url-input"
              value={urlText}
              onChange={(event) => {
                setUrlText(event.target.value);
                setUrlError(null);
              }}
              placeholder="Paste a URL..."
              rows={3}
            />
            <div className={styles.urlActions}>
              <span>{urlError ?? "One per line, or paste a block of text containing links."}</span>
              <button type="submit" disabled={!urlText.trim()}>
                Add
              </button>
            </div>
          </form>

          {queue.length > 0 && (
            <div className={styles.queue} aria-label="Ingestion queue">
              {queue.map((item) => {
                const href = item.mediaId
                  ? item.duplicate
                    ? `/media/${item.mediaId}?duplicate=true`
                    : `/media/${item.mediaId}`
                  : null;
                return (
                  <div key={item.id} className={styles.queueItem}>
                    <div className={styles.itemIcon} aria-hidden="true">
                      {item.source === "file" ? <FileText size={16} /> : <Link size={16} />}
                    </div>
                    <div className={styles.itemText}>
                      <span title={item.label}>{item.label}</span>
                      <small>
                        {item.status === "queued" && "Queued"}
                        {item.status === "working" && (item.source === "file" ? "Uploading..." : "Adding...")}
                        {item.status === "success" && (item.duplicate ? "Already in your library" : "Added")}
                        {item.status === "error" && (item.error ?? "Failed")}
                      </small>
                    </div>
                    <div className={styles.itemActions}>
                      {item.status === "success" && href && (
                        <button type="button" onClick={() => requestOpenInAppPane(href)}>
                          Open
                        </button>
                      )}
                      {item.status === "error" && (
                        <button type="button" onClick={() => retryItem(item)} aria-label={`Retry ${item.label}`}>
                          <RotateCcw size={14} aria-hidden="true" />
                        </button>
                      )}
                      {item.status === "success" ? (
                        <CircleCheck className={styles.successIcon} size={16} aria-label="Success" />
                      ) : item.status === "error" ? (
                        <CircleX className={styles.errorIcon} size={16} aria-label="Error" />
                      ) : item.status === "queued" ? (
                        <button type="button" onClick={() => removeItem(item.id)} aria-label={`Remove ${item.label}`}>
                          <X size={14} aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  ) : null;

  return (
    <>
      {dragActive && (
        <div className={styles.dropOverlay}>
          <div>
            <Plus size={28} aria-hidden="true" />
            <strong>Drop to add to Nexus</strong>
            <span>PDFs, EPUBs, and links are supported.</span>
          </div>
        </div>
      )}
      {tray}
    </>
  );
}
