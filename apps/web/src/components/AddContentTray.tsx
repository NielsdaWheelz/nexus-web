"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CalendarDays,
  CircleCheck,
  CircleX,
  FileText,
  Link,
  Plus,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import {
  OPEN_ADD_CONTENT_EVENT,
  isAddContentMode,
  type AddContentMode,
} from "@/components/addContentEvents";
import LibraryMultiSelectPicker from "@/components/LibraryMultiSelectPicker";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import QuickNotePanel from "@/components/QuickNotePanel";
import OpmlImportPanel from "@/components/OpmlImportPanel";
import { extractUrls } from "@/lib/extractUrls";
import { createNotePage } from "@/lib/notes/api";
import {
  addMediaFromUrl,
  getFileUploadError,
  uploadIngestFile,
} from "@/lib/media/ingestionClient";
import { useNonDefaultLibraries } from "@/lib/media/useNonDefaultLibraries";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import { isEditableTarget } from "@/lib/ui/isEditableTarget";
import { useBodyOverflowLock } from "@/lib/ui/useBodyOverflowLock";
import { useEscapeKey } from "@/lib/ui/useEscapeKey";
import { useFocusTrap } from "@/lib/ui/useFocusTrap";
import { useInitialFocus } from "@/lib/ui/useInitialFocus";
import { useReturnFocus } from "@/lib/ui/useReturnFocus";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import Button from "@/components/ui/Button";
import Textarea from "@/components/ui/Textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import styles from "./AddContentTray.module.css";

type QueueItem = {
  id: number;
  source: "file" | "url";
  label: string;
  libraryIds: string[];
  file?: File;
  url?: string;
  status: "queued" | "working" | "success" | "error";
  error?: string;
  mediaId?: string;
  duplicate?: boolean;
  autoOpen: boolean;
};

const MAX_ACTIVE_UPLOADS = 2;

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
  const libraryPicker = useNonDefaultLibraries();
  const [batchLibraryIds, setBatchLibraryIds] = useState<string[]>([]);
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteFeedback, setNoteFeedback] = useState<FeedbackContent | null>(null);
  const nextIdRef = useRef(1);
  const activeIdsRef = useRef<Set<number>>(new Set());
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const trayRef = useRef<HTMLElement>(null);
  const isMobile = useIsMobileViewport();

  const enqueueFiles = useCallback(
    (files: File[], autoOpenSingle: boolean) => {
      if (files.length === 0) {
        return;
      }
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
            libraryIds: [...batchLibraryIds],
            file,
            status: error ? ("error" as const) : ("queued" as const),
            error: error ?? undefined,
            autoOpen: autoOpenSingle && files.length === 1,
          };
        }),
      ]);
    },
    [batchLibraryIds]
  );

  const enqueueUrls = useCallback(
    (urls: string[], autoOpenSingle: boolean) => {
      if (urls.length === 0) {
        return;
      }
      setMode("content");
      setOpen(true);
      setQueue((current) => [
        ...current,
        ...urls.map((url) => ({
          id: nextIdRef.current++,
          source: "url" as const,
          label: url,
          libraryIds: [...batchLibraryIds],
          url,
          status: "queued" as const,
          autoOpen: autoOpenSingle && urls.length === 1,
        })),
      ]);
    },
    [batchLibraryIds]
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
            libraryIds: item.libraryIds,
          });
        } else {
          if (!item.url) {
            throw new Error("Missing URL.");
          }
          result = await addMediaFromUrl({
            url: item.url,
            libraryIds: item.libraryIds,
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
        event instanceof CustomEvent && isAddContentMode(event.detail?.mode)
          ? event.detail.mode
          : "content";
      setMode(requestedMode);
      if (requestedMode === "quick-note") {
        setNoteFeedback(null);
      }
      setOpen(true);
    };
    window.addEventListener(OPEN_ADD_CONTENT_EVENT, openHandler);
    return () => {
      window.removeEventListener(OPEN_ADD_CONTENT_EVENT, openHandler);
    };
  }, []);

  const { load: loadLibraries } = libraryPicker;
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
      if (isEditableTarget(event.target)) {
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

  useBodyOverflowLock(isMobile && open);
  useFocusTrap(trayRef, isMobile && open);
  useReturnFocus(isMobile && open);
  useInitialFocus(trayRef, isMobile && open);
  useEscapeKey(open, () => setOpen(false));

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

  const createPage = useCallback(async () => {
    setNoteBusy(true);
    setNoteFeedback(null);
    try {
      const page = await createNotePage({ title: "Untitled" });
      setOpen(false);
      requestOpenInAppPane(`/pages/${page.id}`, { titleHint: page.title });
    } catch (error: unknown) {
      setNoteFeedback(toFeedback(error, { fallback: "Page could not be created." }));
    } finally {
      setNoteBusy(false);
    }
  }, []);

  const openToday = useCallback(() => {
    setOpen(false);
    requestOpenInAppPane("/daily", { titleHint: "Today" });
  }, []);

  const modeDescription =
    mode === "opml"
      ? "Import podcast subscriptions from an OPML file."
      : mode === "quick-note"
        ? "Capture a note on today's page."
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
          <Button
            variant="secondary"
            size="md"
            iconOnly
            className={styles.iconButton}
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </header>

        <Tabs
          variant="tabs"
          value={mode}
          onValueChange={(next) => {
            if (isAddContentMode(next)) setMode(next);
          }}
          className={styles.modeTabs}
        >
          <TabsList aria-label="Add content mode">
            <TabsTrigger value="content">Content</TabsTrigger>
            <TabsTrigger value="quick-note">Quick note</TabsTrigger>
            <TabsTrigger value="opml">OPML</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className={styles.body}>
          {mode === "content" ? (
            <>
              <div className={styles.knowledgeActions} aria-label="Notes actions">
                <Button
                  variant="secondary"
                  size="md"
                  className={styles.knowledgeAction}
                  onClick={() => void createPage()}
                  disabled={noteBusy}
                  leadingIcon={<Plus size={16} aria-hidden="true" />}
                >
                  New page
                </Button>
                <Button
                  variant="secondary"
                  size="md"
                  className={styles.knowledgeAction}
                  onClick={openToday}
                  leadingIcon={<CalendarDays size={16} aria-hidden="true" />}
                >
                  Today
                </Button>
                <Button
                  variant="secondary"
                  size="md"
                  className={styles.knowledgeAction}
                  onClick={() => setMode("quick-note")}
                  leadingIcon={<FileText size={16} aria-hidden="true" />}
                >
                  Quick note to today
                </Button>
              </div>
              {noteFeedback ? <FeedbackNotice feedback={noteFeedback} /> : null}

              <div className={styles.libraryField}>
                <label className={styles.libraryLabel}>Also add to</label>
                <LibraryMultiSelectPicker
                  mode="dropdown"
                  selectedLibraryIds={batchLibraryIds}
                  onChange={setBatchLibraryIds}
                  libraries={libraryPicker.libraries.map((library) => ({
                    id: library.id,
                    name: library.name,
                    color: library.color,
                  }))}
                />
                <small className={styles.libraryHelp}>
                  {libraryPicker.error?.title ??
                    "Add new items to one or more libraries on top of My Library."}
                </small>
              </div>

              <Button
                variant="secondary"
                className={styles.dropzone}
                onClick={() => fileInputRef.current?.click()}
              >
                <span className={styles.dropzoneInner}>
                  <Upload size={22} aria-hidden="true" />
                  <span>Upload file</span>
                  <small>PDF up to 100 MB, EPUB up to 50 MB. Select or drop many at once.</small>
                </span>
              </Button>
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
                <Textarea
                  id="ingestion-url-input"
                  size="sm"
                  className={styles.urlTextarea}
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
                  <Button type="submit" variant="primary" size="md" disabled={!urlText.trim()}>
                    Add
                  </Button>
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
                    const allowRowPicker =
                      item.status === "queued" || item.status === "error";
                    return (
                      <div key={item.id} className={styles.queueItem}>
                        <div className={styles.itemIcon} aria-hidden="true">
                          {item.source === "file" ? <FileText size={16} /> : <Link size={16} />}
                        </div>
                        <div className={styles.itemText}>
                          <span title={item.label}>{item.label}</span>
                          <small>
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
                          {allowRowPicker ? (
                            <LibraryMultiSelectPicker
                              mode="dropdown"
                              selectedLibraryIds={item.libraryIds}
                              onChange={(next) =>
                                setQueue((current) =>
                                  current.map((row) =>
                                    row.id === item.id
                                      ? { ...row, libraryIds: next }
                                      : row
                                  )
                                )
                              }
                              libraries={libraryPicker.libraries.map((library) => ({
                                id: library.id,
                                name: library.name,
                                color: library.color,
                              }))}
                            />
                          ) : null}
                          {item.status === "success" && href ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => requestOpenInAppPane(href)}
                            >
                              Open
                            </Button>
                          ) : null}
                          {item.status === "error" ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              iconOnly
                              onClick={() => retryItem(item)}
                              aria-label={`Retry ${item.label}`}
                            >
                              <RotateCcw size={14} aria-hidden="true" />
                            </Button>
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
                            <Button
                              variant="secondary"
                              size="sm"
                              iconOnly
                              onClick={() => removeItem(item.id)}
                              aria-label={`Remove ${item.label}`}
                            >
                              <X size={14} aria-hidden="true" />
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </>
          ) : mode === "quick-note" ? (
            <QuickNotePanel onClose={() => setOpen(false)} />
          ) : (
            <OpmlImportPanel defaultLibraryIds={batchLibraryIds} />
          )}
        </div>
      </section>
    </div>
  );
}
