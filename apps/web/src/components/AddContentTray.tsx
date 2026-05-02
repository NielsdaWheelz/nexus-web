"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CircleCheck,
  CircleX,
  FileText,
  Link,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import {
  OPEN_ADD_CONTENT_EVENT,
  type AddContentMode,
} from "@/components/addContentEvents";
import LibraryTargetPicker, {
  type LibraryTargetPickerItem,
} from "@/components/LibraryTargetPicker";
import StateMessage from "@/components/ui/StateMessage";
import { apiFetch, isApiError } from "@/lib/api/client";
import {
  addMediaFromUrl,
  getFileUploadError,
  uploadIngestFile,
} from "@/lib/media/ingestionClient";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import { getFocusableElements } from "@/lib/ui/getFocusableElements";
import { useFocusTrap } from "@/lib/ui/useFocusTrap";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import styles from "./AddContentTray.module.css";

type QueueItem = {
  id: number;
  source: "file" | "url";
  label: string;
  libraryId: string | null;
  libraryName: string | null;
  file?: File;
  url?: string;
  status: "queued" | "working" | "success" | "error";
  error?: string;
  mediaId?: string;
  duplicate?: boolean;
  autoOpen: boolean;
};

type PodcastOpmlImportResult = {
  total: number;
  imported: number;
  skipped_already_subscribed: number;
  skipped_invalid: number;
  errors: Array<{
    feed_url: string | null;
    error: string;
  }>;
};

type LibrarySummary = {
  id: string;
  name: string;
  is_default: boolean;
  color?: string | null;
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

export default function AddContentTray() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AddContentMode>("content");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [urlText, setUrlText] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [libraries, setLibraries] = useState<LibraryTargetPickerItem[]>([]);
  const [librariesLoading, setLibrariesLoading] = useState(false);
  const [librariesLoaded, setLibrariesLoaded] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<PodcastOpmlImportResult | null>(null);
  const nextIdRef = useRef(1);
  const activeIdsRef = useRef<Set<number>>(new Set());
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const opmlInputRef = useRef<HTMLInputElement>(null);
  const trayRef = useRef<HTMLElement>(null);
  const isMobile = useIsMobileViewport();

  const loadLibraries = useCallback(async () => {
    if (librariesLoading || librariesLoaded) {
      return;
    }
    setLibrariesLoading(true);
    setLibraryError(null);
    try {
      const response = await apiFetch<{ data: LibrarySummary[] }>("/api/libraries");
      setLibraries(
        response.data
          .filter((library) => !library.is_default)
          .map((library) => ({
            id: library.id,
            name: library.name,
            color: library.color ?? null,
            isInLibrary: false,
            canAdd: true,
            canRemove: false,
          }))
      );
      setLibrariesLoaded(true);
    } catch (error) {
      if (isApiError(error)) {
        setLibraryError(error.message);
      } else {
        setLibraryError("Failed to load libraries");
      }
      setLibraries([]);
    } finally {
      setLibrariesLoading(false);
    }
  }, [librariesLoaded, librariesLoading]);

  const enqueueFiles = useCallback(
    (files: File[], autoOpenSingle: boolean) => {
      if (files.length === 0) {
        return;
      }
      const selectedLibraryName =
        libraries.find((library) => library.id === selectedLibraryId)?.name ?? null;
      setMode("content");
      setOpen(true);
      setQueue((current) => [
        ...current,
        ...files.map((file) => {
          const error = getFileUploadError(file);
          return {
            id: nextIdRef.current++,
            source: "file" as const,
            label: file.name,
            libraryId: selectedLibraryId,
            libraryName: selectedLibraryName,
            file,
            status: error ? ("error" as const) : ("queued" as const),
            error: error ?? undefined,
            autoOpen: autoOpenSingle && files.length === 1,
          };
        }),
      ]);
    },
    [libraries, selectedLibraryId]
  );

  const enqueueUrls = useCallback(
    (urls: string[], autoOpenSingle: boolean) => {
      if (urls.length === 0) {
        return;
      }
      const selectedLibraryName =
        libraries.find((library) => library.id === selectedLibraryId)?.name ?? null;
      setMode("content");
      setOpen(true);
      setQueue((current) => [
        ...current,
        ...urls.map((url) => ({
          id: nextIdRef.current++,
          source: "url" as const,
          label: url,
          libraryId: selectedLibraryId,
          libraryName: selectedLibraryName,
          url,
          status: "queued" as const,
          autoOpen: autoOpenSingle && urls.length === 1,
        })),
      ]);
    },
    [libraries, selectedLibraryId]
  );

  const startItem = useCallback((item: QueueItem) => {
    if (activeIdsRef.current.has(item.id)) {
      return;
    }
    activeIdsRef.current.add(item.id);
    setQueue((current) =>
      current.map((row) =>
        row.id === item.id ? { ...row, status: "working", error: undefined } : row
      )
    );

    void (async () => {
      try {
        let result: { mediaId: string; duplicate: boolean };
        if (item.source === "file") {
          if (!item.file) {
            throw new Error("Missing file.");
          }
          result = await uploadIngestFile({
            file: item.file,
            libraryId: item.libraryId,
          });
        } else {
          if (!item.url) {
            throw new Error("Missing URL.");
          }
          result = await addMediaFromUrl({
            url: item.url,
            libraryId: item.libraryId,
          });
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
          requestOpenInAppPane(
            result.duplicate ? `/media/${result.mediaId}?duplicate=true` : `/media/${result.mediaId}`
          );
        }
      } catch (error) {
        const message =
          error instanceof Error && error.message ? error.message : "Failed to add item.";
        setQueue((current) =>
          current.map((row) =>
            row.id === item.id ? { ...row, status: "error", error: message } : row
          )
        );
      } finally {
        activeIdsRef.current.delete(item.id);
      }
    })();
  }, []);

  const handleImportOpml = useCallback(async () => {
    if (!importFile) {
      setImportError("Select an OPML/XML file to import.");
      return;
    }
    setImportBusy(true);
    setImportError(null);
    setImportResult(null);
    try {
      const formData = new FormData();
      formData.append("file", importFile);
      const response = await fetch("/api/podcasts/import/opml", {
        method: "POST",
        body: formData,
      });
      const responseBody = (await response.json().catch(() => null)) as
        | { data?: PodcastOpmlImportResult; error?: { message?: string } }
        | null;
      if (!response.ok) {
        throw new Error(responseBody?.error?.message || "Failed to import OPML file");
      }
      if (!responseBody?.data) {
        throw new Error("Import response missing summary payload");
      }
      setImportResult(responseBody.data);
    } catch (error) {
      if (error instanceof Error && error.message) {
        setImportError(error.message);
      } else {
        setImportError("Failed to import OPML file");
      }
    } finally {
      setImportBusy(false);
    }
  }, [importFile]);

  useEffect(() => {
    const available = MAX_ACTIVE_UPLOADS - activeIdsRef.current.size;
    if (available <= 0) {
      return;
    }
    for (const item of queue.filter((row) => row.status === "queued").slice(0, available)) {
      startItem(item);
    }
  }, [queue, startItem]);

  useEffect(() => {
    const openHandler = (event: Event) => {
      const requestedMode =
        event instanceof CustomEvent
          ? ((event as CustomEvent<{ mode?: AddContentMode }>).detail?.mode ?? "content")
          : "content";
      setMode(requestedMode === "opml" ? "opml" : "content");
      if (requestedMode === "opml") {
        setImportError(null);
        setImportResult(null);
        setImportFile(null);
      }
      setOpen(true);
    };
    window.addEventListener(OPEN_ADD_CONTENT_EVENT, openHandler as EventListener);
    return () => {
      window.removeEventListener(OPEN_ADD_CONTENT_EVENT, openHandler as EventListener);
    };
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    void loadLibraries();
  }, [loadLibraries, open]);

  useEffect(() => {
    const onDragEnter = (event: DragEvent) => {
      if (!dragHasSupportedData(event)) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current += 1;
    };
    const onDragOver = (event: DragEvent) => {
      if (!dragHasSupportedData(event)) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    };
    const onDragLeave = (event: DragEvent) => {
      if (!dragHasSupportedData(event)) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    };
    const onDrop = (event: DragEvent) => {
      const transfer = event.dataTransfer;
      if (!transfer) {
        return;
      }
      const files = Array.from(transfer.files ?? []);
      const uriList = transfer.getData("text/uri-list");
      const plainText = transfer.getData("text/plain");
      const urls = extractUrls(uriList || plainText);
      if (files.length === 0 && urls.length === 0) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current = 0;
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
      if (eventTargetAcceptsText(event.target)) {
        return;
      }
      const urls = extractUrls(event.clipboardData?.getData("text/plain") ?? "");
      if (urls.length === 0) {
        return;
      }
      event.preventDefault();
      enqueueUrls(urls, false);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [enqueueUrls]);

  useEffect(() => {
    if (!open) {
      return;
    }
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
    if (!isMobile || !open) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobile, open]);

  useFocusTrap(trayRef, isMobile && open);

  useEffect(() => {
    if (!isMobile || !open || !trayRef.current) {
      return;
    }
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

  const modeDescription =
    mode === "opml"
      ? "Import podcast subscriptions from an OPML file."
      : "Upload files or paste links.";

  if (!open) {
    return null;
  }

  return (
    <div
      className={isMobile ? styles.mobileBackdrop : styles.desktopLayer}
      onClick={() => setOpen(false)}
    >
      <section
        ref={trayRef}
        className={isMobile ? styles.mobileSheet : styles.panel}
        role="dialog"
        aria-modal={isMobile ? "true" : "false"}
        aria-label="Add content"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        {isMobile ? <div className={styles.handle} aria-hidden="true" /> : null}

        <header className={styles.header}>
          <div>
            <h2>Add content</h2>
            <p>{modeDescription}</p>
          </div>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.modeTabs} role="tablist" aria-label="Add content mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "content"}
            className={mode === "content" ? styles.modeTabActive : styles.modeTab}
            onClick={() => setMode("content")}
          >
            Content
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "opml"}
            className={mode === "opml" ? styles.modeTabActive : styles.modeTab}
            onClick={() => setMode("opml")}
          >
            OPML
          </button>
        </div>

        <div className={styles.body}>
          {mode === "content" ? (
            <>
              <div className={styles.libraryField}>
                <label className={styles.libraryLabel}>Library</label>
                <LibraryTargetPicker
                  label="My Library only"
                  libraries={libraries}
                  loading={librariesLoading}
                  allowNoLibrary
                  noLibraryLabel="My Library only"
                  selectedLibraryId={selectedLibraryId}
                  onOpen={() => {
                    void loadLibraries();
                  }}
                  onSelectLibrary={setSelectedLibraryId}
                  emptyMessage="No non-default libraries available."
                />
                <small className={styles.libraryHelp}>
                  {libraryError ??
                    "Pick one non-default library to add there too, or use My Library only."}
                </small>
              </div>

              <button
                type="button"
                className={styles.dropzone}
                onClick={() => fileInputRef.current?.click()}
              >
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
                  placeholder="Paste a PDF, EPUB, article, or video URL..."
                  rows={3}
                />
                <div className={styles.urlActions}>
                  <span>
                    {urlError ??
                      "One per line, or paste a block of text containing PDF, EPUB, article, or video links."}
                  </span>
                  <button type="submit" disabled={!urlText.trim()}>
                    Add
                  </button>
                </div>
              </form>

              {queue.length > 0 ? (
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
                            {item.libraryName ? `Library: ${item.libraryName} · ` : "My Library · "}
                            {item.status === "queued" ? "Queued" : null}
                            {item.status === "working"
                              ? item.source === "file"
                                ? "Uploading..."
                                : "Adding..."
                              : null}
                            {item.status === "success"
                              ? item.duplicate
                                ? "Already in your library"
                                : "Added"
                              : null}
                            {item.status === "error" ? item.error ?? "Failed" : null}
                          </small>
                        </div>
                        <div className={styles.itemActions}>
                          {item.status === "success" && href ? (
                            <button type="button" onClick={() => requestOpenInAppPane(href)}>
                              Open
                            </button>
                          ) : null}
                          {item.status === "error" ? (
                            <button
                              type="button"
                              onClick={() => retryItem(item)}
                              aria-label={`Retry ${item.label}`}
                            >
                              <RotateCcw size={14} aria-hidden="true" />
                            </button>
                          ) : null}
                          {item.status === "success" ? (
                            <CircleCheck
                              className={styles.successIcon}
                              size={16}
                              aria-label="Success"
                            />
                          ) : null}
                          {item.status === "error" ? (
                            <CircleX
                              className={styles.errorIcon}
                              size={16}
                              aria-label="Error"
                            />
                          ) : null}
                          {item.status === "queued" ? (
                            <button
                              type="button"
                              onClick={() => removeItem(item.id)}
                              aria-label={`Remove ${item.label}`}
                            >
                              <X size={14} aria-hidden="true" />
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className={styles.opmlFieldset}>
                <label className={styles.libraryLabel} htmlFor="opml-file-input">
                  OPML file
                </label>
                <div className={styles.opmlFileRow}>
                  <input
                    id="opml-file-input"
                    ref={opmlInputRef}
                    type="file"
                    accept=".opml,.xml,text/xml,application/xml,application/octet-stream"
                    className={styles.fileInput}
                    aria-label="Import OPML file"
                    onChange={(event) => {
                      setImportFile(event.target.files?.[0] ?? null);
                      setImportError(null);
                      setImportResult(null);
                    }}
                  />
                  <button
                    type="button"
                    className={styles.opmlBrowseButton}
                    onClick={() => opmlInputRef.current?.click()}
                  >
                    Choose file
                  </button>
                  <span className={styles.opmlInputLabel}>
                    {importFile?.name ?? "No file selected"}
                  </span>
                </div>
                <small className={styles.opmlHelper}>
                  Import podcast subscriptions from another app as one explicit add action.
                </small>
              </div>

              <div className={styles.importActions}>
                <button type="button" onClick={handleImportOpml} disabled={importBusy}>
                  {importBusy ? "Importing..." : "Import OPML"}
                </button>
              </div>

              {importError ? <StateMessage variant="error">{importError}</StateMessage> : null}

              {importResult ? (
                <div className={styles.importSummary}>
                  <h3 className={styles.importSummaryTitle}>Import summary</h3>
                  <div className={styles.importStats}>
                    <span>Total: {importResult.total}</span>
                    <span>Imported: {importResult.imported}</span>
                    <span>Already followed: {importResult.skipped_already_subscribed}</span>
                    <span>Invalid: {importResult.skipped_invalid}</span>
                  </div>
                  {importResult.errors.length > 0 ? (
                    <div className={styles.importErrors}>
                      {importResult.errors.map((error, index) => (
                        <div key={`${error.feed_url ?? "missing"}-${index}`}>
                          {error.feed_url ? `${error.feed_url}: ` : ""}
                          {error.error}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
