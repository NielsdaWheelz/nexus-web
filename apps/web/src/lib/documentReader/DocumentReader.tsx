"use client";

// The reader primitive. A host builds a source (and optionally a progress
// port), gets a Reader from useDocumentReader, and renders DocumentReaderView
// with its decorations and callbacks. Everything below is format-agnostic;
// the text and pdf surfaces are geometry.
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  FeedbackNotice,
  FeedbackState,
  FeedbackStatus,
  type FeedbackAnnouncement,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import type { Schema } from "@/lib/api/wire";
import { targetOfLocator, type HighlightColor, type PdfQuad, type TextUnit } from "./model";
import PdfSurface from "./pdf/PdfSurface";
import {
  createReaderRuntime,
  type Reader,
  type ReaderOptions,
  type ReaderRuntime,
  type ReaderState,
} from "./runtime";
import TextSurface from "./text/TextSurface";
import { unresolvedPosition } from "./progress";
import styles from "./documentReader.module.css";

export type {
  Reader,
  ReaderEntry,
  ReaderOptions,
  ReaderState,
} from "./runtime";
export type { NavFailure, NavOutcome, NavState } from "./navigator";
export type { ProgressState } from "./progress";

export interface Mark {
  readonly id: string;
  readonly color: HighlightColor;
  readonly anchor: MarkAnchor;
}
export type MarkAnchor =
  | {
      readonly kind: "text";
      readonly unit: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "pdf";
      readonly page: number;
      readonly quads: readonly PdfQuad[];
    };
export type TextRange = Extract<MarkAnchor, { kind: "text" }>;
export interface NoteRef extends Omit<TextRange, "kind"> {
  readonly key: string;
}
/** What the host paints over the publication; the paint mechanism is the surface's. */
export interface Decorations {
  /** Marks measured against this publication; others are ignored. */
  readonly identity: string;
  /** Topmost first: where marks overlap, the first paints. */
  readonly marks: readonly Mark[];
  readonly noteRefs: readonly NoteRef[];
  readonly focused: string | null;
  readonly hovered: string | null;
}
export type DraftAnchor =
  | TextRange
  | (Extract<MarkAnchor, { kind: "pdf" }> & { readonly exact: string });
export interface Passage {
  readonly identity: string;
  readonly anchor: MarkAnchor;
}
/** A source being inspected, independent of saved marks and a composing selection. */
export interface Inspection {
  readonly identity: string;
  readonly anchors: readonly MarkAnchor[];
  /** Coarse page targets have no invented text geometry. */
  readonly pages: readonly number[];
  readonly precision: "exact" | "approximate" | "page" | "time";
}
export type SelectionCandidate =
  | { readonly kind: "Captured"; readonly anchor: DraftAnchor; readonly quote: string }
  | { readonly kind: "Rejected"; readonly reason: "CrossUnit" | "CrossPage" };
export type SelectionEvent = SelectionCandidate & {
  readonly identity: string;
  readonly input: "pointer" | "keyboard" | "touch";
};
export type SelectionCapture = Extract<SelectionEvent, { readonly kind: "Captured" }>;
export interface PassageGeometry {
  readonly rect: DOMRect;
  readonly lines: readonly DOMRect[];
  readonly bounds: DOMRect;
}
export type MarkEvent =
  | { readonly kind: "hover"; readonly ids: readonly string[] }
  | {
      readonly kind: "activate";
      readonly identity: string;
      readonly marks: readonly Mark[];
      readonly input: SelectionCapture["input"];
    };
export interface DocumentReaderViewProps {
  readonly reader: Reader;
  readonly profile: Schema<"ReaderProfileOut">;
  readonly isMobile: boolean;
  /** Hosts silence a reader while its pane is inactive. */
  readonly announcement?: FeedbackAnnouncement;
  readonly decorations?: Decorations;
  /** The composing passage, independent of the saved decoration map. */
  readonly activePassage?: Passage | null;
  readonly inspection?: Inspection | null;
  /** Absent: selection is inert. */
  readonly onSelection?: (event: SelectionEvent) => void;
  readonly onMarks?: (event: MarkEvent) => void;
  readonly onApparatus?: (
    key: string,
    rect: DOMRect,
    kind: "activate" | "hover",
  ) => void;
  readonly onSeekTime?: (ms: number) => void;
  readonly renderEmbed?: (embedId: string) => ReactNode;
  readonly renderPostActions?: (unit: TextUnit) => ReactNode;
  /** false when the host already presents the source title; capture facts remain. */
  readonly showCaptureTitle?: boolean;
  readonly before?: ReactNode;
  readonly end?: ReactNode;
}

/** A new reader per key; hosted readers wait until their publication is readable. */
export function useDocumentReader(
  key: string,
  options: ReaderOptions,
  enabled = true,
): Reader {
  const current = useRef<{ key: string; runtime: ReaderRuntime } | null>(null);
  if (current.current?.key !== key) {
    current.current = { key, runtime: createReaderRuntime(options) };
  }
  const { runtime } = current.current;
  useEffect(() => {
    if (!enabled) return;
    const unmount = runtime.mount();
    const revalidate = () => {
      if (document.visibilityState === "visible") runtime.revalidate();
    };
    const blur = () => runtime.away(false);
    const hide = () => runtime.away(true);
    const visibility = () =>
      document.visibilityState === "hidden" ? hide() : revalidate();
    const events: [Window | Document, string, () => void][] = [
      [window, "focus", revalidate],
      [window, "pageshow", revalidate],
      [window, "online", revalidate],
      [window, "blur", blur],
      [window, "pagehide", hide],
      [document, "visibilitychange", visibility],
    ];
    for (const [target, name, listener] of events)
      target.addEventListener(name, listener);
    return () => {
      for (const [target, name, listener] of events)
        target.removeEventListener(name, listener);
      unmount();
    };
  }, [enabled, runtime]);
  return runtime;
}

export function useReaderState<T>(
  reader: Reader,
  select: (state: ReaderState) => T,
): T {
  const read = () => select(reader.getState());
  return useSyncExternalStore(reader.subscribe, read, read);
}

/** Typography as CSS custom properties, from the reader profile. */
export function readerSurfaceStyle(
  profile: Schema<"ReaderProfileOut">,
): CSSProperties {
  return {
    "--reader-font-family":
      profile.font_family === "sans"
        ? "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
        : "Iowan Old Style, Palatino Linotype, Book Antiqua, Palatino, Georgia, Times New Roman, serif",
    "--reader-font-size-px": `${profile.font_size_px}px`,
    "--reader-line-height": String(profile.line_height),
    "--reader-column-width-ch": `${profile.column_width_ch}ch`,
  } as CSSProperties;
}

export default function DocumentReaderView(
  props: DocumentReaderViewProps,
): ReactElement {
  // Every Reader is the runtime useDocumentReader made.
  const runtime = props.reader as ReaderRuntime;
  const publication = useReaderState(runtime, (state) => state.document);
  const tracked = useReaderState(runtime, (state) => state.progress !== null);
  const positionNeedsReload = useReaderState(runtime, (state) => state.progress?.kind === "LoadFailed" && state.progress.recovery === "ReloadDocument");
  const frame = useRef<HTMLDivElement>(null);
  const scrollIndicator = useRef<HTMLDivElement>(null);
  const returnFocus = useCallback(
    () => frame.current?.querySelector<HTMLElement>("[data-pane-content]") ?? frame.current,
    [],
  );
  const announcement = props.announcement ?? "Polite";
  let body: ReactNode;
  if (publication.status === "loading") {
    body = (
      <div className={styles.feedback}>
        <FeedbackState content={{ tone: "Neutral", title: "opening document…" }} announcement={announcement} />
      </div>
    );
  } else if (publication.status === "failed") {
    body = (
      <div className={styles.feedback}>
        <FeedbackState
          content={{ tone: "Danger", title: "couldn’t open this document" }}
          announcement={announcement}
          actions={[{ label: "retry", onClick: runtime.retryLoad, busy: publication.retrying }]}
          returnFocus={returnFocus}
        />
      </div>
    );
  } else if (publication.doc.kind === "pdf") {
    body = (
      <PdfSurface
        runtime={runtime}
        doc={publication.doc}
        view={props}
        scrollIndicator={scrollIndicator}
      />
    );
  } else {
    body = (
      <TextSurface
        runtime={runtime}
        doc={publication.doc}
        structure={publication.structure}
        view={props}
        scrollIndicator={scrollIndicator}
      />
    );
  }
  return (
    <div
      ref={frame}
      className={styles.frame}
      tabIndex={-1}
      style={readerSurfaceStyle(props.profile)}
      data-theme={props.profile.theme}
      data-hyphenation={props.profile.hyphenation}
    >
      {tracked ? <StatusStrip reader={runtime} announcement={announcement} returnFocus={returnFocus} /> : null}
      {publication.status === "ready" && publication.refreshFailure !== null && !positionNeedsReload ? (
        <div className={`${styles.status} ${styles.feedback}`}>
          <FeedbackNotice
            content={{ tone: "Warning", title: "couldn’t reload this document", message: "the previous copy is still open. retry to check for updates." }}
            announcement={announcement}
            actions={[{ label: "retry document", onClick: runtime.retryLoad, busy: publication.refreshing }]}
            disclosure="Anchored"
            returnFocus={returnFocus}
          />
        </div>
      ) : null}
      {body}
      <div
        ref={scrollIndicator}
        className={styles.scrollIndicator}
        aria-hidden="true"
      >
        <div className={styles.scrollIndicatorVertical} />
        <div className={styles.scrollIndicatorHorizontal} />
      </div>
    </div>
  );
}

const FAILURE: Record<
  NonNullable<ReaderState["navigation"]["failure"]>,
  string
> = {
  CaptureUnavailable: "couldn't hold your reading spot. try again.",
  TargetUnavailable: "couldn't open that passage.",
  SourceChanged: "your reading spot is unavailable in this version.",
  PositioningFailed: "couldn't open that passage.",
};

/** Where the held spot is: its section, its page, or how far through. */
function originLabel(state: ReaderState): string | null {
  const { origin } = state.navigation;
  if (state.document.status !== "ready" || origin === null) return null;
  const { doc, structure } = state.document;
  const target =
    origin.kind === "placement"
      ? { kind: "point" as const, point: origin.placement.point }
      : targetOfLocator(doc, origin.locator);
  if (target?.kind !== "point") return null;
  const { point } = target;
  if (point.kind === "pdf") return `page ${point.page}`;
  return (
    structure.sectionAt(point)?.label ??
    `${Math.round(structure.fraction(point) * 100)}%`
  );
}

function StatusStrip({ reader, announcement, returnFocus }: {
  readonly reader: Reader;
  readonly announcement: FeedbackAnnouncement;
  readonly returnFocus: () => HTMLElement | null;
}) {
  const navigation = useReaderState(reader, (state) => state.navigation);
  const progress = useReaderState(reader, (state) => state.progress);
  const documentReady = useReaderState(reader, (state) => state.document.status === "ready");
  const documentRefreshing = useReaderState(reader, (state) => state.document.status === "ready" && state.document.refreshing);
  const unavailable = useReaderState(
    reader,
    (state) => state.savedSpotUnavailable,
  );
  const label = useReaderState(reader, originLabel);
  const exploring = navigation.mode === "Exploring";
  const ready = progress?.kind === "Ready" ? progress : null;
  const unresolved = ready ? unresolvedPosition(ready.view) : null;
  const handoff = unresolved ? null : ready?.handoff ?? null;
  const title = !exploring
    ? null
    : navigation.originUnavailable
      ? "held place unavailable in this version"
      : navigation.origin
        ? `place held${label ? ` · ${label}` : ""}`
        : "inspecting this passage";
  const error = navigation.failure && FAILURE[navigation.failure];
  const resolve = async (choice: "Canonical" | "Device", trigger: HTMLButtonElement) => {
    if (ready?.saving) return;
    const heldFocus = document.activeElement === trigger;
    await reader.resolveHandoff(choice);
    if (heldFocus && !trigger.isConnected && document.activeElement === document.body)
      returnFocus()?.focus({ preventScroll: true });
  };
  const loadFailed = documentReady && progress?.kind === "LoadFailed" ? progress : null;
  if (!unresolved && !title && !error && !handoff && !ready?.saveFailed && !unavailable && !loadFailed) return null;
  return (
    <div className={`${styles.status} ${styles.feedback}`} role="group" aria-label="reading position">
      {unresolved ? <>
        <FeedbackNotice content={{ tone: "Warning", title: "your saved reading position no longer matches this version." }}
          announcement={announcement} actions={[{ label: "read from here", onClick: reader.continueHere, busy: documentRefreshing || ready?.saving || navigation.positioning }]} />
        <details><summary>show previous passage</summary><p className={styles.previousPassage}>{unresolved.excerpt}</p></details>
      </> : null}
      {!unresolved && title && navigation.origin ? (
        <FeedbackStatus
          content={{ tone: "Neutral", title }}
          announcement={announcement}
          disclosure="Anchored"
          returnFocus={returnFocus}
          actions={[
            {
              label: "return",
              onClick: () => void reader.returnToSpot(),
              busy: navigation.positioning,
              disabledReason: navigation.originUnavailable ? "this version no longer contains the held place" : undefined,
            },
            { label: "read from here", onClick: reader.continueHere, busy: navigation.positioning },
          ]}
        />
      ) : !unresolved && title ? <ReadingOptions reader={reader} title={title} announcement={announcement} returnFocus={returnFocus} /> : null}
      {error ? <FeedbackNotice content={{ tone: "Warning", title: error }} announcement={announcement} /> : null}
      {handoff ? (
        <div className={styles.choice}>
          <FeedbackNotice content={{ tone: "Warning", title: "a newer reading place is available" }} announcement={announcement} returnFocus={returnFocus} />
          <Button variant="ghost" size="sm" aria-busy={ready?.saving || undefined} aria-disabled={ready?.saving || undefined} onClick={(event) => void resolve("Canonical", event.currentTarget)}>
            use newer place
          </Button>
          <Button variant="ghost" size="sm" aria-busy={ready?.saving || undefined} aria-disabled={ready?.saving || undefined} onClick={(event) => void resolve("Device", event.currentTarget)}>
            keep my place
          </Button>
        </div>
      ) : null}
      {ready?.saveFailed ? (
        <FeedbackNotice
          content={{ tone: "Warning", title: "reading position not synced", message: "your place is still held in this tab. retry to sync it." }}
          announcement={announcement}
          actions={[{ label: "retry", onClick: reader.retrySave, busy: ready.saving || ready.retrying }]}
          disclosure="Anchored"
          returnFocus={returnFocus}
        />
      ) : null}
      {unavailable && !exploring ? (
        <FeedbackNotice content={{ tone: "Warning", title: "saved place unavailable in this document" }} announcement={announcement} />
      ) : null}
      {loadFailed ? (
        <FeedbackNotice
          content={{
            tone: "Warning",
            title: loadFailed.recovery === "RetryPosition" ? "couldn’t load your reading position" : "reading position needs a document reload",
            message: "you can keep reading. position saving is paused until recovery succeeds.",
          }}
          announcement={announcement}
          actions={[{
            label: loadFailed.recovery === "RetryPosition" ? "retry position" : "reload document",
            onClick: loadFailed.recovery === "RetryPosition" ? reader.revalidate : reader.retryLoad,
            busy: loadFailed.retrying || documentRefreshing,
          }]}
          disclosure="Anchored"
          returnFocus={returnFocus}
        />
      ) : null}
    </div>
  );
}

/** A first deep link has no earlier cursor to return to. Adoption remains explicit. */
function ReadingOptions({ reader, title, announcement, returnFocus }: {
  readonly reader: Reader;
  readonly title: string;
  readonly announcement: FeedbackAnnouncement;
  readonly returnFocus: () => HTMLElement | null;
}) {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const positioning = useReaderState(reader, (state) => state.navigation.positioning);
  return (
    <div className={styles.choice}>
      <FeedbackStatus content={{ tone: "Neutral", title }} announcement={announcement} />
      <Button variant="ghost" size="sm" aria-expanded={anchor !== null} aria-controls={id} onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}>
        reading options
      </Button>
      <FloatingActionSurface open={anchor !== null} anchor={anchor} id={id} disclosure role="group" label="reading options" align="start" placement="below" flip onDismiss={() => setAnchor(null)}>
        <FeedbackStatus
          content={{ tone: "Neutral", title: "make this your reading place" }}
          announcement="None"
          actions={[{ label: "read from here", onClick: reader.continueHere, busy: positioning }]}
          returnFocus={returnFocus}
        />
      </FloatingActionSurface>
    </div>
  );
}
