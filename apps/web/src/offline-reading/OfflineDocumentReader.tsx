import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import PdfReader, {
  type PdfReaderDecorationWrites,
} from "@/components/PdfReader";
import TextDocumentReader from "@/components/reader/TextDocumentReader";
import type {
  PdfHighlightOut,
} from "@/lib/reader/ReaderDecorations";
import {
  buildTextReaderLocatorAtOffset,
  createDocumentReaderSession,
  preferredReaderLocator,
  type LoadedDocumentReaderSession,
} from "@/lib/reader/DocumentReaderSession";
import type { ReaderProgressView } from "@/lib/reader/ReaderProgressPort";
import type { ReaderScrollPositioner } from "@/lib/reader/paneScroll";
import { buildReaderSurfaceStyle } from "@/lib/reader/readerSurfaceStyle";
import type { ReaderProfile, ReaderResumeState } from "@/lib/reader/types";
import { canonicalCpLength } from "@/lib/reader/textOffsets";
import {
  OfflineReaderProgressPort,
  OfflineReaderSource,
} from "@/lib/offlineReading/OfflineReaderAdapters";
import {
  OFFLINE_READING_COPY,
  offlineReaderLocatorContext,
  offlineReadingConflictChoiceLabel,
  offlineReadingConflictLocators,
} from "@/lib/offlineReading/presentation";
import type {
  OfflineReadingControllerRuntime,
  OpenedOfflineReading,
} from "@/lib/offlineReading/runtime";
import styles from "./offlineReading.module.css";

const offlinePositioner: ReaderScrollPositioner = {
  async run(operation) {
    await operation({
      setTop(scrollport, top) {
        scrollport.scrollTop = Math.max(0, top);
      },
      adjustTop(scrollport, delta) {
        scrollport.scrollTop = Math.max(0, scrollport.scrollTop + delta);
      },
      reveal(scrollport, target) {
        const top = target.getBoundingClientRect().top - scrollport.getBoundingClientRect().top;
        scrollport.scrollTop = Math.max(0, scrollport.scrollTop + top);
      },
    });
  },
};

/**
 * The packaged shelf never reaches the reader-profile service (offline
 * personalization is a non-goal), so it states the reading typography it
 * renders with. Without this the shared reader resolves `--reader-*` through
 * their fallbacks and sets prose in the mono stack.
 */
const OFFLINE_SHELF_READER_PROFILE: ReaderProfile = {
  theme: "dark",
  font_family: "serif",
  font_size_px: 19,
  line_height: 1.6,
  column_width_ch: 66,
  focus_mode: "off",
  hyphenation: "auto",
};
const offlineReaderSurfaceStyle = buildReaderSurfaceStyle(
  OFFLINE_SHELF_READER_PROFILE,
);

const noOfflinePdfDecorations: PdfReaderDecorationWrites = {
  async createHighlight(): Promise<PdfHighlightOut> {
    throw new Error("Highlights are unavailable in downloaded copies");
  },
  async updateHighlight(): Promise<void> {
    throw new Error("Highlights are unavailable in downloaded copies");
  },
};

type DocumentLoad =
  | { readonly kind: "Loading" }
  | { readonly kind: "Loaded"; readonly loaded: LoadedDocumentReaderSession }
  | { readonly kind: "Failed" };

function progressNotice(view: ReaderProgressView): string | null {
  switch (view.kind) {
    case "ContentChanged":
      return OFFLINE_READING_COPY.changedSourceNotice;
    case "SourceUnavailable":
      return OFFLINE_READING_COPY.sourceUnavailableNotice;
    case "Conflict":
      return OFFLINE_READING_COPY.conflictNotice;
    case "Canonical":
    case "Pending":
      return null;
  }
}

function saveStatusMessage(kind: ReaderProgressView["kind"] | "Failed"): string {
  switch (kind) {
    case "Conflict":
      return OFFLINE_READING_COPY.conflictNotice;
    case "ContentChanged":
      return OFFLINE_READING_COPY.changedSourceNotice;
    case "SourceUnavailable":
      return OFFLINE_READING_COPY.sourceUnavailableNotice;
    case "Failed":
      return "Position could not be stored on this device. Try again.";
    case "Canonical":
    case "Pending":
      return "Position stored on this device";
  }
}

export default function OfflineDocumentReader({
  controller,
  mediaId,
  opened,
  authoritativeProgress,
  onClose,
  onRemoveRequested,
}: {
  readonly controller: OfflineReadingControllerRuntime;
  readonly mediaId: string;
  readonly opened: OpenedOfflineReading;
  readonly authoritativeProgress: ReaderProgressView | null;
  /** Leaves the reader for the shelf; the shelf owns the lease close. */
  readonly onClose: () => void;
  /** Opens the shelf's confirmed Remove dialog for this copy. */
  readonly onRemoveRequested: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const session = useMemo(() => {
    // `attempt` is a load-identity input: Retry builds a fresh session rather
    // than reusing the one whose package fetch failed.
    void attempt;
    const progress = new OfflineReaderProgressPort(controller, mediaId, opened);
    return createDocumentReaderSession({
      mediaId,
      source: new OfflineReaderSource(mediaId, opened),
      progress,
    });
  }, [attempt, controller, mediaId, opened]);
  const [load, setLoad] = useState<DocumentLoad>({ kind: "Loading" });
  const [progress, setProgress] = useState<ReaderProgressView>(opened.progress);
  const [epubSection, setEpubSection] = useState<
    Extract<LoadedDocumentReaderSession["document"], { kind: "Epub" }>["section"] | null
  >(null);
  const [webFragmentId, setWebFragmentId] = useState<string | null>(null);
  const [readerEpoch, setReaderEpoch] = useState(0);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [changedSourceAcknowledged, setChangedSourceAcknowledged] = useState(false);
  const authoritativeProgressRef = useRef(authoritativeProgress);
  const readerRootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLElement>(null);

  useEffect(() => {
    authoritativeProgressRef.current = authoritativeProgress;
    if (authoritativeProgress !== null) setProgress(authoritativeProgress);
  }, [authoritativeProgress]);

  useEffect(() => {
    const abort = new AbortController();
    let current = true;
    setLoad({ kind: "Loading" });
    session.load(abort.signal).then(
      (result) => {
        if (!current) return;
        setLoad({ kind: "Loaded", loaded: result });
        setProgress(authoritativeProgressRef.current ?? result.progress);
        if (result.document.kind === "Epub") setEpubSection(result.document.section);
        if (result.document.kind === "WebArticle") setWebFragmentId(result.document.activeFragment.id);
      },
      () => {
        // A lease that expired, a package that failed verification, or an
        // undecodable reader document must land on a typed failure with a
        // valid action -- never an unhandled rejection behind a spinner.
        if (!current || abort.signal.aborted) return;
        setLoad({ kind: "Failed" });
      },
    );
    return () => {
      current = false;
      abort.abort();
    };
  }, [session]);

  if (load.kind === "Failed") {
    return (
      <div className={styles.documentReader}>
        <p role="alert" className={styles.notice}>
          This downloaded copy could not be opened. Its files may be incomplete
          or no longer verified on this device.
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.action}
            onClick={() => setAttempt((current) => current + 1)}
          >
            Try again
          </button>
          <button type="button" className={styles.quietAction} onClick={onClose}>
            Back to downloads
          </button>
          <button
            type="button"
            className={styles.quietAction}
            onClick={onRemoveRequested}
          >
            Remove downloaded copy
          </button>
        </div>
      </div>
    );
  }
  if (load.kind === "Loading") return <p role="status">Opening verified copy…</p>;
  const loaded = load.loaded;
  const document = loaded.document;
  const preferredLocator = preferredReaderLocator(progress);
  const webFragment = document.kind === "WebArticle"
    ? document.fragments.find((fragment) => fragment.id === webFragmentId) ?? document.activeFragment
    : null;
  const sectionLabel = (targetId: string): string | null =>
    document.kind === "Epub"
      ? document.navigation.sections.find(
          (section) => section.section_id === targetId,
        )?.label ?? null
      : document.kind === "WebArticle"
        ? document.navigation.sections.find(
            (section) => section.fragment_id === targetId,
          )?.label ?? null
        : null;

  const saveWebActivation = (fragmentId: string) => {
    if (document.kind !== "WebArticle") return;
    const fragment = document.fragments.find((candidate) => candidate.id === fragmentId);
    if (fragment === undefined) return;
    const documentStartOffset = document.fragments
      .slice(0, document.fragments.indexOf(fragment))
      .reduce((sum, candidate) => sum + canonicalCpLength(candidate.canonical_text), 0);
    const locator = buildTextReaderLocatorAtOffset({
      anchorOffset: 0,
      canonicalText: fragment.canonical_text,
      fragmentId: fragment.id,
      format: "web",
      documentStartOffset,
      documentLength: document.fragments.reduce(
        (sum, candidate) => sum + canonicalCpLength(candidate.canonical_text),
        0,
      ),
      isFinalUnit: document.fragments.at(-1)?.id === fragment.id,
      epubSection: null,
      epubAnchorId: null,
      positionBucketCodePoints: 1000,
    });
    if (locator !== null) save(locator);
  };

  const saveEpubActivation = (
    section: NonNullable<typeof epubSection>,
    anchorId: string | null = section.anchor_id,
  ) => {
    if (document.kind !== "Epub") return;
    const navigation = document.navigation.sections.find(
      (candidate) => candidate.section_id === section.section_id,
    );
    if (navigation === undefined) return;
    const locator = buildTextReaderLocatorAtOffset({
      anchorOffset: navigation.start_offset,
      canonicalText: section.canonical_text,
      fragmentId: section.fragment_id,
      format: "epub",
      documentStartOffset: document.navigation.fragments
        .filter((fragment) => fragment.fragment_idx < section.fragment_idx)
        .reduce((sum, fragment) => sum + fragment.char_count, 0),
      documentLength: document.navigation.fragments.reduce(
        (sum, fragment) => sum + fragment.char_count,
        0,
      ),
      isFinalUnit:
        document.navigation.fragments.at(-1)?.fragment_id === section.fragment_id,
      epubSection: section,
      epubAnchorId: anchorId,
      positionBucketCodePoints: 1000,
    });
    if (locator !== null) save(locator);
  };

  const applyProgress = async (next: ReaderProgressView) => {
    setProgress(next);
    const locator = preferredReaderLocator(next);
    if (document.kind === "WebArticle" && locator?.kind === "web") {
      setWebFragmentId(locator.target.fragment_id);
    } else if (document.kind === "Epub" && locator?.kind === "epub") {
      const abort = new AbortController();
      setEpubSection(await session.loadEpubSection(locator.target.section_id, abort.signal));
    }
    setReaderEpoch((current) => current + 1);
  };

  const save = (locator: ReaderResumeState) => {
    void session.progress.save(mediaId, locator).then((result) => {
      const next = result.kind === "Canonical" || result.kind === "Conflict" ? result : result.view;
      setProgress(next);
      setSaveStatus(
        saveStatusMessage(
          result.kind === "DurablyPending" ? result.view.kind : result.kind,
        ),
      );
    }).catch(() => {
      setSaveStatus(saveStatusMessage("Failed"));
    });
  };

  const activeText = document.kind === "WebArticle" && webFragment !== null
    ? {
        format: "web" as const,
        fragmentId: webFragment.id,
        canonicalText: webFragment.canonical_text,
        renderedHtml: webFragment.html_sanitized,
        documentStartOffset: document.fragments
          .slice(0, document.fragments.indexOf(webFragment))
          .reduce((sum, fragment) => sum + canonicalCpLength(fragment.canonical_text), 0),
        documentLength: document.fragments.reduce(
          (sum, fragment) => sum + canonicalCpLength(fragment.canonical_text),
          0,
        ),
        isFinalUnit: document.fragments.at(-1)?.id === webFragment.id,
        epubSection: null,
        anchorId: null,
      }
    : document.kind === "Epub" && epubSection !== null
      ? {
          format: "epub" as const,
          fragmentId: epubSection.fragment_id,
          canonicalText: epubSection.canonical_text,
          renderedHtml: epubSection.html_sanitized,
          documentStartOffset: document.navigation.fragments
            .filter((fragment) => fragment.fragment_idx < epubSection.fragment_idx)
            .reduce((sum, fragment) => sum + fragment.char_count, 0),
          documentLength: document.navigation.fragments.reduce(
            (sum, fragment) => sum + fragment.char_count,
            0,
          ),
          isFinalUnit: document.navigation.fragments.at(-1)?.fragment_id === epubSection.fragment_id,
          epubSection,
          anchorId: epubSection.anchor_id,
        }
      : null;
  const restoredOffset = activeText !== null &&
    ((preferredLocator?.kind === "web" && preferredLocator.target.fragment_id === activeText.fragmentId) ||
      (preferredLocator?.kind === "epub" && preferredLocator.target.section_id === activeText.epubSection?.section_id))
    ? preferredLocator.locations.text_offset ??
      Math.round((preferredLocator.locations.progression ?? 0) * canonicalCpLength(activeText.canonicalText))
    : activeText?.format === "epub"
      ? document.kind === "Epub"
        ? document.navigation.sections.find(
            (section) => section.section_id === activeText.epubSection?.section_id,
          )?.start_offset ?? 0
        : 0
      : 0;
  const notice = progressNotice(progress);
  const conflict = progress.kind === "Conflict"
    ? offlineReadingConflictLocators(progress)
    : null;
  const handleEpubContentClick = (event: MouseEvent<HTMLDivElement>) => {
    if (document.kind !== "Epub" || !event.nativeEvent.isTrusted) return;
    const target = event.target instanceof Element
      ? event.target.closest("a[data-nexus-section-id]")
      : null;
    if (!(target instanceof HTMLAnchorElement)) return;
    event.preventDefault();
    const targetSectionId = target.dataset.nexusSectionId;
    const declared = document.navigation.sections.some(
      (section) => section.section_id === targetSectionId,
    );
    if (!declared || targetSectionId === undefined) return;
    const rawHref = target.getAttribute("href");
    const targetAnchorId = (() => {
      try {
        const hashIndex = rawHref?.lastIndexOf("#") ?? -1;
        return rawHref !== null && hashIndex >= 0 && hashIndex < rawHref.length - 1
          ? decodeURIComponent(rawHref.slice(hashIndex + 1))
          : null;
      } catch {
        return null;
      }
    })();
    const revealAnchor = () => {
      const anchorId = targetAnchorId ?? "";
      if (anchorId.length === 0) return;
      const candidate = contentRef.current?.querySelectorAll<HTMLElement>("[id]");
      const anchor = candidate ? [...candidate].find((element) => element.id === anchorId) : undefined;
      anchor?.scrollIntoView({ block: "start" });
    };
    if (targetSectionId === epubSection?.section_id) {
      revealAnchor();
      saveEpubActivation(epubSection, targetAnchorId);
      return;
    }
    const abort = new AbortController();
    void session.loadEpubSection(targetSectionId, abort.signal).then((next) => {
      setEpubSection(next);
      setReaderEpoch((current) => current + 1);
      saveEpubActivation(next, targetAnchorId);
      requestAnimationFrame(revealAnchor);
    });
  };

  return (
    <div className={styles.documentReader}>
      {document.kind === "WebArticle" ? (
        <p className={styles.notice}>{OFFLINE_READING_COPY.textOnlyNotice}</p>
      ) : null}
      {notice === null ? null : (
        <p role="alert" className={styles.notice}>{notice}</p>
      )}
      {progress.kind === "ContentChanged" && !changedSourceAcknowledged ? (
        <div className={styles.actions} aria-label="Changed source">
          <button
            type="button"
            className={styles.action}
            onClick={() => setChangedSourceAcknowledged(true)}
          >
            {OFFLINE_READING_COPY.continueAction}
          </button>
          <button
            type="button"
            className={styles.quietAction}
            onClick={onRemoveRequested}
          >
            {OFFLINE_READING_COPY.removeConfirmAction}
          </button>
        </div>
      ) : null}
      {conflict === null ? null : (
        <div className={styles.actions} aria-label="Choose saved location">
          <button
            type="button"
            className={styles.action}
            onClick={() => void session.progress.resolve(mediaId, "Canonical").then(applyProgress)}
          >
            {offlineReadingConflictChoiceLabel(
              "Canonical",
              offlineReaderLocatorContext(conflict.canonical, sectionLabel),
            )}
          </button>
          <button
            type="button"
            className={styles.action}
            onClick={() => void session.progress.resolve(mediaId, "Device").then(applyProgress)}
          >
            {offlineReadingConflictChoiceLabel(
              "Device",
              offlineReaderLocatorContext(conflict.device, sectionLabel),
            )}
          </button>
        </div>
      )}
      {saveStatus === null ? null : (
        <p className={styles.saved} role="status">{saveStatus}</p>
      )}

      {document.kind === "Pdf" ? (
        <PdfReader
          key={`pdf:${readerEpoch}`}
          mediaId={mediaId}
          resources={{
            signedUrl: { status: "ready", data: document.document },
            pageHighlights: { status: "ready", data: [] },
            requestSignedUrlRefresh: () => undefined,
          }}
          decorations={noOfflinePdfDecorations}
          isMobile
          mobileChromeEnabled={false}
          acquireMobileChromeVisibleLock={() => () => undefined}
          scrollPositioner={offlinePositioner}
          handleAuthenticationError={() => false}
          startPageNumber={preferredLocator?.kind === "pdf" ? preferredLocator.page : 1}
          startPageProgression={
            preferredLocator?.kind === "pdf"
              ? preferredLocator.page_progression ?? undefined
              : undefined
          }
          startZoom={
            preferredLocator?.kind === "pdf"
              ? preferredLocator.zoom ?? undefined
              : undefined
          }
          onSemanticViewportChange={(viewport) => {
            if (viewport?.intent === "Reader") save(viewport.primaryLocator);
          }}
        />
      ) : activeText === null ? null : (
        <>
          {document.kind === "WebArticle" ? (
            <nav className={styles.chapterNav} aria-label="Article sections">
              {document.navigation.sections.map((entry) => (
                <button
                  key={entry.fragment_id}
                  type="button"
                  aria-current={entry.fragment_id === activeText.fragmentId ? "page" : undefined}
                  onClick={() => {
                    setWebFragmentId(entry.fragment_id);
                    setReaderEpoch((current) => current + 1);
                    saveWebActivation(entry.fragment_id);
                  }}
                >
                  {entry.label}
                </button>
              ))}
            </nav>
          ) : null}
          {document.kind === "Epub" ? (
            <nav className={styles.chapterNav} aria-label="EPUB contents">
              {document.navigation.sections.map((section) => (
                <button
                  key={section.section_id}
                  type="button"
                  aria-current={section.section_id === activeText.epubSection?.section_id ? "page" : undefined}
                  onClick={() => {
                    const abort = new AbortController();
                    void session.loadEpubSection(section.section_id, abort.signal).then((next) => {
                      setEpubSection(next);
                      setReaderEpoch((current) => current + 1);
                      saveEpubActivation(next);
                    });
                  }}
                >
                  {section.label}
                </button>
              ))}
            </nav>
          ) : null}
          <TextDocumentReader
            key={`${activeText.format}:${activeText.fragmentId}:${readerEpoch}`}
            mediaId={mediaId}
            scrollPositioner={offlinePositioner}
            readerRootRef={readerRootRef}
            contentRef={contentRef}
            textViewportRef={viewportRef}
            textEndRef={endRef}
            readerThemeClassName=""
            readerSurfaceStyle={offlineReaderSurfaceStyle}
            focusMode={OFFLINE_SHELF_READER_PROFILE.focus_mode}
            hyphenation={OFFLINE_SHELF_READER_PROFILE.hyphenation}
            contentState={{ status: "ready", renderedHtml: activeText.renderedHtml }}
            onViewportReady={() => undefined}
            onViewportScroll={() => undefined}
            onTrustedScrollIntent={() => undefined}
            endContent={null}
            onContentClick={handleEpubContentClick}
            onContentPointerOver={() => undefined}
            onContentPointerOut={() => undefined}
            onContentFocus={() => undefined}
            onContentBlur={() => undefined}
            onCanonicalPosition={(offset) => {
              if (offset < 0) return;
              const locator = buildTextReaderLocatorAtOffset({
                anchorOffset: Math.min(offset, canonicalCpLength(activeText.canonicalText)),
                canonicalText: activeText.canonicalText,
                fragmentId: activeText.fragmentId,
                format: activeText.format,
                documentStartOffset: activeText.documentStartOffset,
                documentLength: activeText.documentLength,
                isFinalUnit: activeText.isFinalUnit,
                epubSection: activeText.epubSection,
                epubAnchorId: activeText.anchorId,
                positionBucketCodePoints: 1000,
              });
              if (locator !== null) save(locator);
            }}
            canonicalLength={canonicalCpLength(activeText.canonicalText)}
            initialCanonicalOffset={restoredOffset}
          />
        </>
      )}
    </div>
  );
}
