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
import LibraryDestinationPicker from "@/components/LibraryDestinationPicker";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import QuickNotePanel from "@/components/QuickNotePanel";
import OpmlImportPanel from "@/components/OpmlImportPanel";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { extractUrls } from "@/lib/extractUrls";
import { createNotePage } from "@/lib/notes/api";
import {
  getFileUploadError,
  isFailedSourceIngest,
  uploadIngestFile,
  type SourceIngestResult,
} from "@/lib/media/ingestionClient";
import {
  SAVED_INGEST_FAILED_STATUS,
  toMediaCaptureFeedback,
} from "@/lib/media/captureFeedback";
import {
  SOURCE_INGEST_CONCURRENCY,
  captureSourceUrl,
} from "@/lib/media/sourceUrlCapture";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import { isEditableTarget } from "@/lib/ui/isEditableTarget";
import { useEscapeKey } from "@/lib/ui/useEscapeKey";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import Button from "@/components/ui/Button";
import MobileSheet from "@/components/ui/MobileSheet";
import Textarea from "@/components/ui/Textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { createRandomId } from "@/lib/createRandomId";
import styles from "./AddContentTray.module.css";

type QueueItem = {
  id: number;
  source: "file" | "url";
  label: string;
  libraryIds: string[];
  file?: File;
  url?: string;
  status: "queued" | "working" | "success" | "saved_failure" | "error";
  error?: FeedbackContent;
  mediaId?: string;
  sourceAttemptId?: string;
  duplicate?: boolean;
  idempotencyKey?: string;
  autoOpen: boolean;
};

const MAX_ACTIVE_UPLOADS = SOURCE_INGEST_CONCURRENCY;

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
  const [batchLibraryIds, setBatchLibraryIds] = useState<string[]>([]);
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteFeedback, setNoteFeedback] = useState<FeedbackContent | null>(null);
  const nextIdRef = useRef(1);
  const activeIdsRef = useRef<Set<number>>(new Set());
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
            idempotencyKey: createRandomId("media-upload"),
            status: error ? ("error" as const) : ("queued" as const),
            error: error ? { severity: "error" as const, title: error } : undefined,
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
          idempotencyKey: createRandomId("media-url"),
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
        let result: SourceIngestResult;
        if (item.source === "file") {
          if (!item.file) {
            throw new Error("Missing file.");
          }
          result = await uploadIngestFile({
            file: item.file,
            libraryIds: item.libraryIds,
            idempotencyKey: item.idempotencyKey,
          });
        } else {
          if (!item.url) {
            throw new Error("Missing URL.");
          }
          const capture = await captureSourceUrl({
            url: item.url,
            libraryIds: item.libraryIds,
            idempotencyKey: item.idempotencyKey,
            fallback: "Failed to add item.",
          });
          if (!capture.ok) {
            setQueue((current) =>
              current.map((row) =>
                row.id === item.id
                  ? {
                      ...row,
                      status: "error",
                      error: capture.feedback,
                    }
                  : row
              )
            );
            return;
          }
          result = capture.result;
        }

        const sourceFailed = isFailedSourceIngest(result);
        setQueue((current) =>
          current.map((row) =>
            row.id === item.id
              ? {
                  ...row,
                  status: sourceFailed ? "saved_failure" : "success",
                  error: sourceFailed
                    ? {
                        severity: "warning",
                        title: SAVED_INGEST_FAILED_STATUS,
                      }
                    : undefined,
                  mediaId: result.mediaId,
                  sourceAttemptId: result.sourceAttemptId,
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
        if (handleUnauthenticatedApiError(error)) return;
        setQueue((current) =>
          current.map((row) =>
            row.id === item.id
              ? {
                  ...row,
                  status: "error",
                  error: toMediaCaptureFeedback(error, "Failed to add item."),
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

  // Mobile gets the full modal contract (lock/trap/focus/Escape/history) from
  // MobileSheet; the desktop panel keeps only its own Escape dismissal.
  useEscapeKey(open && !isMobile, () => setOpen(false));

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
              error: error ? { severity: "error", title: error } : undefined,
              mediaId: undefined,
              sourceAttemptId: undefined,
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
      if (handleUnauthenticatedApiError(error)) return;
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

  const trayContent = (
    <>
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
              <LibraryDestinationPicker
                selectedLibraryIds={batchLibraryIds}
                onChange={setBatchLibraryIds}
                label="Also add to"
              />
              <small className={styles.libraryHelp}>
                Add new items to one or more libraries on top of My Library.
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
                          {item.status === "saved_failure"
                            ? item.error?.title ?? SAVED_INGEST_FAILED_STATUS
                            : null}
                          {item.status === "error" ? item.error?.title ?? "Failed" : null}
                        </small>
                        {(item.status === "error" || item.status === "saved_failure") &&
                        item.error?.requestId ? (
                          <small>Nexus request ID: {item.error.requestId}</small>
                        ) : null}
                      </div>
                      <div className={styles.itemActions}>
                        {allowRowPicker ? (
                          <LibraryDestinationPicker
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
                            label="Libraries"
                          />
                        ) : null}
                        {(item.status === "success" ||
                          item.status === "saved_failure" ||
                          item.status === "error") &&
                        href ? (
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
                        {item.status === "error" || item.status === "saved_failure" ? (
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
    </>
  );

  // The sheet must stay mounted (MobileSheet mount contract); only the desktop
  // panel may conditionally render.
  return (
    <>
      <MobileSheet active={open && isMobile} onDismiss={() => setOpen(false)} ariaLabel="Add content">
        {trayContent}
      </MobileSheet>
      {open && !isMobile ? (
        <div className={styles.desktopLayer} onClick={() => setOpen(false)}>
          <section
            className={styles.panel}
            role="dialog"
            aria-modal="false"
            aria-label="Add content"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            {trayContent}
          </section>
        </div>
      ) : null}
    </>
  );
}
