"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CircleCheck,
  CircleX,
  FileText,
  Link,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import LibraryDestinationPicker from "@/components/LibraryDestinationPicker";
import { type FeedbackContent } from "@/components/feedback/Feedback";
import OpmlImportPanel from "@/components/OpmlImportPanel";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { extractUrls } from "@/lib/extractUrls";
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
import type { AddSeed, LauncherActionTarget } from "@/lib/launcher/model";
import Button from "@/components/ui/Button";
import Textarea from "@/components/ui/Textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { createRandomId } from "@/lib/createRandomId";
import styles from "./AddPanel.module.css";

// The add UI inside the Launcher exposes the same affordances as the old tray
// minus quick-note (which moved to CreatePanel): URL add, file upload + queue,
// and OPML import. "url"/"file" share the content view (they differ only in
// initial focus); "opml" shows the OPML import.
type AddView = "content" | "opml";

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

function viewForSeed(mode: AddSeed["mode"]): AddView {
  return mode === "opml" ? "opml" : "content";
}

function dropHasSupportedData(event: React.DragEvent): boolean {
  const types = Array.from(event.dataTransfer.types);
  return types.includes("Files") || types.includes("text/uri-list");
}

export default function AddPanel({
  seed,
  onOpen,
  onClose,
  onBack,
}: {
  seed: AddSeed;
  onOpen: (target: LauncherActionTarget) => void;
  onClose: () => void;
  onBack: () => void;
}): React.ReactElement {
  const [view, setView] = useState<AddView>(() => viewForSeed(seed.mode));
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [urlText, setUrlText] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [batchLibraryIds, setBatchLibraryIds] = useState<string[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const nextIdRef = useRef(1);
  const activeIdsRef = useRef<Set<number>>(new Set());
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const urlInputRef = useRef<HTMLTextAreaElement>(null);
  const dropzoneRef = useRef<HTMLButtonElement>(null);

  const enqueueFiles = useCallback(
    (files: File[], autoOpenSingle: boolean) => {
      if (files.length === 0) {
        return;
      }
      setView("content");
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
      setView("content");
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

  const startItem = useCallback(
    (item: QueueItem) => {
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
            onOpen({
              kind: "href",
              href: result.duplicate
                ? `/media/${result.mediaId}?duplicate=true`
                : `/media/${result.mediaId}`,
              externalShell: false,
            });
            // A completed single add that opened a pane dismisses the whole Launcher.
            onClose();
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
    },
    [onOpen, onClose]
  );

  useEffect(() => {
    const available = MAX_ACTIVE_UPLOADS - activeIdsRef.current.size;
    if (available <= 0) {
      return;
    }
    for (const item of queue.filter((row) => row.status === "queued").slice(0, available)) {
      startItem(item);
    }
  }, [queue, startItem]);

  // Seed-driven initial focus: URL field for "url", the upload control for "file".
  // (OPML's own picker lives inside OpmlImportPanel.)
  useEffect(() => {
    if (seed.mode === "url") {
      urlInputRef.current?.focus();
    } else if (seed.mode === "file") {
      dropzoneRef.current?.focus();
    }
  }, [seed.mode]);

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

  // Drop is scoped to the panel's dropzone (the global window drag/drop + paste
  // capture belonged to the always-mounted tray; the host surface owns the rest).
  const onDropzoneDragEnter = useCallback((event: React.DragEvent) => {
    if (!dropHasSupportedData(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  }, []);
  const onDropzoneDragOver = useCallback((event: React.DragEvent) => {
    if (!dropHasSupportedData(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);
  const onDropzoneDragLeave = useCallback((event: React.DragEvent) => {
    if (!dropHasSupportedData(event)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }, []);
  const onDropzoneDrop = useCallback(
    (event: React.DragEvent) => {
      const transfer = event.dataTransfer;
      const files = Array.from(transfer.files);
      const uriList = transfer.getData("text/uri-list");
      const plainText = transfer.getData("text/plain");
      const urls = extractUrls(uriList || plainText);
      dragDepthRef.current = 0;
      setDragActive(false);
      if (files.length === 0 && urls.length === 0) {
        return;
      }
      event.preventDefault();
      enqueueFiles(files, false);
      enqueueUrls(urls, false);
    },
    [enqueueFiles, enqueueUrls]
  );

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <Button
          variant="secondary"
          size="md"
          iconOnly
          className={styles.iconButton}
          onClick={onBack}
          aria-label="Back"
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </Button>
        <div className={styles.heading}>
          <h2>Add content</h2>
          <p>
            {view === "opml"
              ? "Import podcast subscriptions from an OPML file."
              : "Upload files or paste links."}
          </p>
        </div>
      </header>

      <Tabs
        variant="tabs"
        value={view}
        onValueChange={(next) => {
          if (next === "content" || next === "opml") setView(next);
        }}
        className={styles.modeTabs}
      >
        <TabsList aria-label="Add content mode">
          <TabsTrigger value="content">Content</TabsTrigger>
          <TabsTrigger value="opml">OPML</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className={styles.body}>
        {view === "content" ? (
          <>
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
              ref={dropzoneRef}
              variant="secondary"
              className={`${styles.dropzone}${dragActive ? ` ${styles.dropzoneActive}` : ""}`}
              onClick={() => fileInputRef.current?.click()}
              onDragEnter={onDropzoneDragEnter}
              onDragOver={onDropzoneDragOver}
              onDragLeave={onDropzoneDragLeave}
              onDrop={onDropzoneDrop}
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
                ref={urlInputRef}
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
                  const allowRowPicker = item.status === "queued" || item.status === "error";
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
                                  row.id === item.id ? { ...row, libraryIds: next } : row
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
                            onClick={() => onOpen({ kind: "href", href, externalShell: false })}
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
                          <CircleX className={styles.errorIcon} size={16} aria-label="Error" />
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
        ) : (
          <OpmlImportPanel defaultLibraryIds={batchLibraryIds} />
        )}
      </div>
    </div>
  );
}
