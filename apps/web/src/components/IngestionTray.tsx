"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CircleCheck,
  CircleX,
  FileText,
  Link,
  Mic,
  Plus,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import {
  OPEN_ADD_CONTENT_EVENT,
  type AddContentMode,
} from "@/components/CommandPalette";
import { getFocusableElements } from "@/lib/ui/getFocusableElements";
import { useFocusTrap } from "@/lib/ui/useFocusTrap";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import {
  addMediaFromUrl,
  getFileUploadError,
  uploadIngestFile,
} from "@/lib/media/ingestionClient";
import LibraryTargetPicker, {
  type LibraryTargetPickerItem,
} from "@/components/LibraryTargetPicker";
import { apiFetch, isApiError } from "@/lib/api/client";
import StateMessage from "@/components/ui/StateMessage";
import { AppList, AppListItem } from "@/components/ui/AppList";
import styles from "./IngestionTray.module.css";

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

type PodcastDiscoveryItem = {
  podcast_id: string | null;
  provider_podcast_id: string;
  title: string;
  author: string | null;
  feed_url: string;
  website_url: string | null;
  image_url: string | null;
  description: string | null;
};

type PodcastSubscribeResult = {
  podcast_id: string;
  subscription_created: boolean;
  sync_status:
    | "pending"
    | "running"
    | "partial"
    | "complete"
    | "source_limited"
    | "failed";
  sync_enqueued: boolean;
  sync_error_code: string | null;
  sync_error_message: string | null;
  sync_attempts: number;
  last_synced_at: string | null;
  window_size: number;
};

type PodcastSubscriptionSnapshot = {
  podcast_id: string;
  sync_status: PodcastSubscribeResult["sync_status"];
};

type PodcastSubscriptionListRow = {
  podcast_id: string;
  sync_status: PodcastSubscribeResult["sync_status"];
  podcast: {
    provider_podcast_id: string;
  };
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
const PODCAST_SUBSCRIPTION_PAGE_SIZE = 100;

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
  const [dragActive, setDragActive] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [urlText, setUrlText] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [libraries, setLibraries] = useState<LibraryTargetPickerItem[]>([]);
  const [librariesLoading, setLibrariesLoading] = useState(false);
  const [librariesLoaded, setLibrariesLoaded] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(null);
  const [podcastQuery, setPodcastQuery] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [discoverResults, setDiscoverResults] = useState<PodcastDiscoveryItem[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [subscriptionByProviderId, setSubscriptionByProviderId] = useState<
    Record<string, PodcastSubscriptionSnapshot>
  >({});
  const [subscriptionsHydrated, setSubscriptionsHydrated] = useState(false);
  const [subscribingProviderIds, setSubscribingProviderIds] = useState<Set<string>>(
    new Set()
  );
  const [librariesByPodcastId, setLibrariesByPodcastId] = useState<
    Record<string, LibraryTargetPickerItem[]>
  >({});
  const [loadingLibraryPodcastIds, setLoadingLibraryPodcastIds] = useState<Set<string>>(
    new Set()
  );
  const [busyLibraryMembershipKeys, setBusyLibraryMembershipKeys] = useState<Set<string>>(
    new Set()
  );
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

  const hydrateSubscriptions = useCallback(async () => {
    if (subscriptionsHydrated) {
      return;
    }
    const next: Record<string, PodcastSubscriptionSnapshot> = {};
    let offset = 0;

    while (true) {
      const response = await apiFetch<{ data: PodcastSubscriptionListRow[] }>(
        `/api/podcasts/subscriptions?limit=${PODCAST_SUBSCRIPTION_PAGE_SIZE}&offset=${offset}`
      );
      for (const row of response.data) {
        next[row.podcast.provider_podcast_id] = {
          podcast_id: row.podcast_id,
          sync_status: row.sync_status,
        };
      }
      if (response.data.length < PODCAST_SUBSCRIPTION_PAGE_SIZE) {
        break;
      }
      offset += PODCAST_SUBSCRIPTION_PAGE_SIZE;
    }

    setSubscriptionByProviderId(next);
    setSubscriptionsHydrated(true);
  }, [subscriptionsHydrated]);

  const enqueueFiles = useCallback(
    (files: File[], autoOpenSingle: boolean) => {
      if (files.length === 0) {
        return;
      }
      const selectedLibraryName =
        libraries.find((library) => library.id === selectedLibraryId)?.name ?? null;
      setOpen(true);
      setMode("content");
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
      setOpen(true);
      setMode("content");
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
          setOpen(false);
          requestOpenInAppPane(
            result.duplicate
              ? `/media/${result.mediaId}?duplicate=true`
              : `/media/${result.mediaId}`
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

  const loadPodcastLibraries = useCallback(
    async (podcastId: string) => {
      if (loadingLibraryPodcastIds.has(podcastId) || librariesByPodcastId[podcastId]) {
        return;
      }
      setLoadingLibraryPodcastIds((prev) => new Set(prev).add(podcastId));
      setDiscoverError(null);
      try {
        const response = await apiFetch<{
          data: Array<{
            id: string;
            name: string;
            color: string | null;
            is_in_library: boolean;
            can_add: boolean;
            can_remove: boolean;
          }>;
        }>(`/api/podcasts/${podcastId}/libraries`);
        setLibrariesByPodcastId((prev) => ({
          ...prev,
          [podcastId]: response.data.map((library) => ({
            id: library.id,
            name: library.name,
            color: library.color,
            isInLibrary: library.is_in_library,
            canAdd: library.can_add,
            canRemove: library.can_remove,
          })),
        }));
      } catch (error) {
        if (isApiError(error)) {
          setDiscoverError(error.message);
        } else {
          setDiscoverError("Failed to load podcast libraries");
        }
      } finally {
        setLoadingLibraryPodcastIds((prev) => {
          const next = new Set(prev);
          next.delete(podcastId);
          return next;
        });
      }
    },
    [librariesByPodcastId, loadingLibraryPodcastIds]
  );

  const handlePodcastSearch = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = podcastQuery.trim();
      if (!trimmed) {
        return;
      }

      setDiscovering(true);
      setDiscoverError(null);
      setHasSearched(true);

      try {
        await hydrateSubscriptions();
        const params = new URLSearchParams({ q: trimmed, limit: "10" });
        const response = await apiFetch<{ data: PodcastDiscoveryItem[] }>(
          `/api/podcasts/discover?${params.toString()}`
        );
        setDiscoverResults(response.data);
      } catch (error) {
        if (isApiError(error)) {
          setDiscoverError(error.message);
        } else {
          setDiscoverError("Podcast discovery failed");
        }
      } finally {
        setDiscovering(false);
      }
    },
    [hydrateSubscriptions, podcastQuery]
  );

  const handleSubscribe = useCallback(
    async (item: PodcastDiscoveryItem, libraryId: string | null = null) => {
      const providerPodcastId = item.provider_podcast_id;
      setSubscribingProviderIds((prev) => new Set(prev).add(providerPodcastId));
      setDiscoverError(null);
      try {
        const response = await apiFetch<{ data: PodcastSubscribeResult }>(
          "/api/podcasts/subscriptions",
          {
            method: "POST",
            body: JSON.stringify({
              provider_podcast_id: item.provider_podcast_id,
              title: item.title,
              author: item.author,
              feed_url: item.feed_url,
              website_url: item.website_url,
              image_url: item.image_url,
              description: item.description,
              library_id: libraryId,
            }),
          }
        );
        setSubscriptionByProviderId((prev) => ({
          ...prev,
          [providerPodcastId]: {
            podcast_id: response.data.podcast_id,
            sync_status: response.data.sync_status,
          },
        }));
        setDiscoverResults((prev) =>
          prev.map((result) =>
            result.provider_podcast_id === providerPodcastId
              ? { ...result, podcast_id: response.data.podcast_id }
              : result
          )
        );
        if (libraryId) {
          setLibrariesByPodcastId((prev) => ({
            ...prev,
            [response.data.podcast_id]: libraries.map((library) =>
              library.id === libraryId
                ? {
                    ...library,
                    isInLibrary: true,
                    canAdd: false,
                    canRemove: true,
                  }
                : library
            ),
          }));
        }
      } catch (error) {
        if (isApiError(error)) {
          setDiscoverError(error.message);
        } else {
          setDiscoverError("Podcast subscription failed");
        }
      } finally {
        setSubscribingProviderIds((prev) => {
          const next = new Set(prev);
          next.delete(providerPodcastId);
          return next;
        });
      }
    },
    [libraries]
  );

  const handleAddPodcastToLibrary = useCallback(async (podcastId: string, libraryId: string) => {
    const busyKey = `${libraryId}:${podcastId}`;
    setBusyLibraryMembershipKeys((prev) => new Set(prev).add(busyKey));
    setDiscoverError(null);
    try {
      await apiFetch(`/api/libraries/${libraryId}/podcasts`, {
        method: "POST",
        body: JSON.stringify({ podcast_id: podcastId }),
      });
      setLibrariesByPodcastId((prev) => ({
        ...prev,
        [podcastId]: (prev[podcastId] ?? []).map((library) =>
          library.id === libraryId
            ? {
                ...library,
                isInLibrary: true,
                canAdd: false,
                canRemove: true,
              }
            : library
        ),
      }));
    } catch (error) {
      if (isApiError(error)) {
        setDiscoverError(error.message);
      } else {
        setDiscoverError("Failed to add podcast to library");
      }
    } finally {
      setBusyLibraryMembershipKeys((prev) => {
        const next = new Set(prev);
        next.delete(busyKey);
        return next;
      });
    }
  }, []);

  const handleRemovePodcastFromLibrary = useCallback(
    async (podcastId: string, libraryId: string) => {
      const busyKey = `${libraryId}:${podcastId}`;
      setBusyLibraryMembershipKeys((prev) => new Set(prev).add(busyKey));
      setDiscoverError(null);
      try {
        await apiFetch(`/api/libraries/${libraryId}/podcasts/${podcastId}`, {
          method: "DELETE",
        });
        setLibrariesByPodcastId((prev) => ({
          ...prev,
          [podcastId]: (prev[podcastId] ?? []).map((library) =>
            library.id === libraryId
              ? {
                  ...library,
                  isInLibrary: false,
                  canAdd: true,
                  canRemove: false,
                }
              : library
          ),
        }));
      } catch (error) {
        if (isApiError(error)) {
          setDiscoverError(error.message);
        } else {
          setDiscoverError("Failed to remove podcast from library");
        }
      } finally {
        setBusyLibraryMembershipKeys((prev) => {
          const next = new Set(prev);
          next.delete(busyKey);
          return next;
        });
      }
    },
    []
  );

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
      setSubscriptionsHydrated(false);
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
      setMode(requestedMode);
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
      setDragActive(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!dragHasSupportedData(event)) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
      setDragActive(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (!dragHasSupportedData(event)) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setDragActive(false);
      }
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

  let modeDescription = "Upload files or paste links.";
  if (mode === "podcast") {
    modeDescription = "Search shows, subscribe, and place them into libraries.";
  } else if (mode === "opml") {
    modeDescription = "Import podcast subscriptions from an OPML file.";
  }

  const tray = open ? (
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
        {isMobile && <div className={styles.handle} aria-hidden="true" />}
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
            aria-selected={mode === "podcast"}
            className={mode === "podcast" ? styles.modeTabActive : styles.modeTab}
            onClick={() => setMode("podcast")}
          >
            Podcast
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
                  label="Choose library"
                  libraries={libraries}
                  loading={librariesLoading}
                  allowNoLibrary
                  noLibraryLabel="No library"
                  selectedLibraryId={selectedLibraryId}
                  onOpen={() => {
                    void loadLibraries();
                  }}
                  onSelectLibrary={setSelectedLibraryId}
                  emptyMessage="No non-default libraries available."
                />
                <small className={styles.libraryHelp}>
                  {libraryError ?? "Pick one library to target new uploads, or leave it empty."}
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
                            {item.libraryName ? `Library: ${item.libraryName} · ` : "No library · "}
                            {item.status === "queued" && "Queued"}
                            {item.status === "working" &&
                              (item.source === "file" ? "Uploading..." : "Adding...")}
                            {item.status === "success" &&
                              (item.duplicate ? "Already in your library" : "Added")}
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
                            <button
                              type="button"
                              onClick={() => retryItem(item)}
                              aria-label={`Retry ${item.label}`}
                            >
                              <RotateCcw size={14} aria-hidden="true" />
                            </button>
                          )}
                          {item.status === "success" ? (
                            <CircleCheck
                              className={styles.successIcon}
                              size={16}
                              aria-label="Success"
                            />
                          ) : item.status === "error" ? (
                            <CircleX
                              className={styles.errorIcon}
                              size={16}
                              aria-label="Error"
                            />
                          ) : item.status === "queued" ? (
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
              )}
            </>
          ) : null}

          {mode === "podcast" ? (
            <>
              <form className={styles.discoveryForm} onSubmit={handlePodcastSearch}>
                <input
                  className={styles.input}
                  type="search"
                  value={podcastQuery}
                  onChange={(event) => setPodcastQuery(event.target.value)}
                  placeholder="Search podcasts by title or topic..."
                />
                <button
                  type="submit"
                  className={styles.searchButton}
                  disabled={discovering || !podcastQuery.trim()}
                >
                  {discovering ? "Searching..." : "Search"}
                </button>
              </form>

              {discoverError ? <StateMessage variant="error">{discoverError}</StateMessage> : null}

              {hasSearched && !discovering && discoverResults.length === 0 ? (
                <StateMessage variant="empty">No podcasts found for this query.</StateMessage>
              ) : null}

              {discoverResults.length > 0 ? (
                <AppList>
                  {discoverResults.map((result) => {
                    const subscription = subscriptionByProviderId[result.provider_podcast_id];
                    const podcastId = subscription?.podcast_id ?? result.podcast_id;
                    const isSubscribing = subscribingProviderIds.has(result.provider_podcast_id);
                    const pickerLibraries = podcastId
                      ? (librariesByPodcastId[podcastId] ?? []).map((library) => {
                          const busyKey = `${library.id}:${podcastId}`;
                          if (!busyLibraryMembershipKeys.has(busyKey)) {
                            return library;
                          }
                          return {
                            ...library,
                            canAdd: false,
                            canRemove: false,
                          };
                        })
                      : [];

                    return (
                      <AppListItem
                        key={result.provider_podcast_id}
                        href={podcastId ? `/podcasts/${podcastId}` : result.website_url || result.feed_url}
                        target={podcastId ? undefined : "_blank"}
                        rel={podcastId ? undefined : "noopener noreferrer"}
                        icon={
                          result.image_url ? (
                            <span
                              className={styles.podcastArtwork}
                              style={{ backgroundImage: `url(${result.image_url})` }}
                              aria-hidden="true"
                            />
                          ) : (
                            <span className={styles.thumbnailFallback}>POD</span>
                          )
                        }
                        title={result.title}
                        description={result.author || "Unknown author"}
                        meta={result.feed_url}
                        trailing={
                          subscription ? (
                            <span className={styles.subscriptionState}>
                              {subscription.sync_status}
                            </span>
                          ) : undefined
                        }
                        actions={
                          subscription && podcastId ? (
                            <>
                              <a href={`/podcasts/${podcastId}`} className={styles.viewPodcastLink}>
                                View podcast
                              </a>
                              <LibraryTargetPicker
                                label="Libraries"
                                libraries={pickerLibraries}
                                loading={loadingLibraryPodcastIds.has(podcastId)}
                                onOpen={() => {
                                  void loadPodcastLibraries(podcastId);
                                }}
                                onAddToLibrary={(libraryId) => {
                                  void handleAddPodcastToLibrary(podcastId, libraryId);
                                }}
                                onRemoveFromLibrary={(libraryId) => {
                                  void handleRemovePodcastFromLibrary(podcastId, libraryId);
                                }}
                                emptyMessage="No non-default libraries available."
                              />
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                className={styles.subscribeButton}
                                disabled={isSubscribing}
                                onClick={() => void handleSubscribe(result)}
                              >
                                {isSubscribing ? "Subscribing..." : "Subscribe"}
                              </button>
                              <LibraryTargetPicker
                                label="Add to library"
                                libraries={libraries}
                                loading={librariesLoading}
                                disabled={isSubscribing}
                                onOpen={() => {
                                  void loadLibraries();
                                }}
                                onSelectLibrary={(libraryId) => {
                                  void handleSubscribe(result, libraryId);
                                }}
                                emptyMessage="No non-default libraries available."
                              />
                            </>
                          )
                        }
                      />
                    );
                  })}
                </AppList>
              ) : null}
            </>
          ) : null}

          {mode === "opml" ? (
            <div className={styles.opmlPanel}>
              <p className={styles.opmlDescription}>
                Import subscriptions from another podcast app using an OPML export.
              </p>
              <button
                type="button"
                className={styles.dropzone}
                onClick={() => opmlInputRef.current?.click()}
              >
                <Mic size={22} aria-hidden="true" />
                <span>Select OPML file</span>
                <small>Choose one `.opml` or `.xml` file to import subscriptions.</small>
              </button>
              <input
                ref={opmlInputRef}
                type="file"
                accept=".opml,.xml,text/xml,application/xml"
                className={styles.fileInput}
                aria-label="Import OPML file"
                onChange={(event) => {
                  setImportFile(event.target.files?.[0] ?? null);
                  setImportError(null);
                  setImportResult(null);
                }}
              />
              <div className={styles.opmlActions}>
                <span className={styles.opmlFileName}>
                  {importFile ? importFile.name : "No file selected"}
                </span>
                <button
                  type="button"
                  className={styles.searchButton}
                  disabled={!importFile || importBusy}
                  onClick={() => void handleImportOpml()}
                >
                  {importBusy ? "Importing..." : "Import OPML"}
                </button>
              </div>
              {importError ? <StateMessage variant="error">{importError}</StateMessage> : null}
              {importResult ? (
                <div className={styles.importSummary}>
                  <p className={styles.importSummaryTitle}>Import summary</p>
                  <p>
                    {importResult.imported} imported, {importResult.skipped_already_subscribed} already
                    subscribed, {importResult.skipped_invalid} invalid.
                  </p>
                  {importResult.errors.length > 0 ? (
                    <ul className={styles.importErrors}>
                      {importResult.errors.map((error, index) => (
                        <li key={`${error.feed_url ?? "missing"}-${index}`}>
                          {error.feed_url ? `${error.feed_url}: ` : ""}
                          {error.error}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  ) : null;

  return (
    <>
      {dragActive ? (
        <div className={styles.dropOverlay}>
          <div>
            <Plus size={28} aria-hidden="true" />
            <strong>Drop to add to Nexus</strong>
            <span>Drop PDFs, EPUBs, or PDF, EPUB, article, and video links.</span>
          </div>
        </div>
      ) : null}
      {tray}
    </>
  );
}
