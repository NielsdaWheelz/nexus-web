"use client";

// The reader primitive. A host builds a source (and optionally a progress
// port), gets a Reader from useDocumentReader, and renders DocumentReaderView
// with its decorations and callbacks. Everything below is format-agnostic;
// the text and pdf surfaces are geometry.
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import type { Schema } from "@/lib/api/wire";
import { targetOfLocator, type HighlightColor, type PdfQuad } from "./model";
import PdfSurface from "./pdf/PdfSurface";
import {
  createReaderRuntime,
  type Reader,
  type ReaderOptions,
  type ReaderRuntime,
  type ReaderState,
} from "./runtime";
import TextSurface from "./text/TextSurface";
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
export interface NoteRef {
  readonly key: string;
  readonly unit: string;
  readonly start: number;
  readonly end: number;
}
/** What the host paints over the publication; the paint mechanism is the surface's. */
export interface Decorations {
  /** Marks measured against this publication; others are ignored. */
  readonly identity: string;
  readonly marks: readonly Mark[];
  readonly noteRefs: readonly NoteRef[];
  readonly focused: string | null;
  readonly hovered: string | null;
}
export type DraftAnchor =
  | Extract<MarkAnchor, { kind: "text" }>
  | (Extract<MarkAnchor, { kind: "pdf" }> & { readonly exact: string });
export interface SelectionCapture {
  readonly anchor: DraftAnchor;
  readonly quote: string;
  readonly rect: DOMRect;
}
export interface MarkEvent {
  readonly kind: "activate" | "hover";
  readonly ids: readonly string[];
  readonly rect: DOMRect | null;
}
export interface DocumentReaderViewProps {
  readonly reader: Reader;
  readonly profile: Schema<"ReaderProfileOut">;
  readonly isMobile: boolean;
  readonly decorations?: Decorations;
  /** Absent: selection is inert. */
  readonly onSelection?: (capture: SelectionCapture | null) => void;
  readonly onMarks?: (event: MarkEvent) => void;
  readonly onApparatus?: (
    key: string,
    rect: DOMRect,
    kind: "activate" | "hover",
  ) => void;
  readonly onSeekTime?: (ms: number) => void;
  readonly renderEmbed?: (embedId: string) => ReactNode;
  readonly before?: ReactNode;
  readonly end?: ReactNode;
}

/** A new reader per key (hosted: media id; public: token; shelf: copy). */
export function useDocumentReader(key: string, options: ReaderOptions): Reader {
  const current = useRef<{ key: string; runtime: ReaderRuntime } | null>(null);
  if (current.current?.key !== key) {
    current.current = { key, runtime: createReaderRuntime(options) };
  }
  const { runtime } = current.current;
  useEffect(() => {
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
  }, [runtime]);
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
  let body: ReactNode;
  if (publication.status === "loading") {
    body = (
      <p role="status" className={styles.note}>
        Opening…
      </p>
    );
  } else if (publication.status === "failed") {
    body = (
      <p role="alert" className={styles.note}>
        This document could not be opened.{" "}
        <button
          type="button"
          className={styles.link}
          onClick={runtime.retryLoad}
        >
          Retry
        </button>
      </p>
    );
  } else if (publication.doc.kind === "pdf") {
    body = <PdfSurface runtime={runtime} doc={publication.doc} view={props} />;
  } else {
    body = <TextSurface runtime={runtime} doc={publication.doc} view={props} />;
  }
  return (
    <div
      className={styles.frame}
      style={readerSurfaceStyle(props.profile)}
      data-hyphenation={props.profile.hyphenation}
    >
      {tracked ? <StatusStrip reader={runtime} /> : null}
      {body}
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

function StatusStrip({ reader }: { readonly reader: Reader }) {
  const navigation = useReaderState(reader, (state) => state.navigation);
  const progress = useReaderState(reader, (state) => state.progress);
  const unavailable = useReaderState(
    reader,
    (state) => state.savedSpotUnavailable,
  );
  const label = useReaderState(reader, originLabel);
  const [collapsed, setCollapsed] = useState(false);
  const exploring = navigation.mode === "Exploring";
  useEffect(() => {
    if (!exploring) setCollapsed(false);
  }, [exploring]);
  const ready = progress?.kind === "Ready" ? progress : null;
  const handoff = ready?.handoff ?? null;
  const title = !exploring
    ? null
    : navigation.originUnavailable
      ? "reading spot unavailable"
      : navigation.origin
        ? `reading spot held${label ? ` · ${label}` : ""}`
        : "inspecting this passage";
  const error = navigation.failure && FAILURE[navigation.failure];
  const notices = [
    title,
    error,
    handoff && "newer reading spot available",
    ready?.saveFailed && "progress not synced",
    unavailable && "saved reading spot unavailable",
    progress?.kind === "LoadFailed" && "reading position unavailable",
  ].filter(Boolean);
  if (notices.length === 0) return null;
  return (
    <div className={styles.status} role="group" aria-label="reading position">
      <span className={styles.live} aria-live="polite">
        {notices.join(". ")}
      </span>
      {title && collapsed ? (
        <button
          type="button"
          className={styles.link}
          onClick={() => setCollapsed(false)}
        >
          {title} · options
        </button>
      ) : title ? (
        <span className={styles.choice}>
          <span className={styles.title}>{title}</span>
          {navigation.origin ? (
            <button
              type="button"
              className={styles.link}
              disabled={navigation.originUnavailable}
              onClick={() => void reader.returnToSpot()}
            >
              back to your spot
            </button>
          ) : null}
          <button
            type="button"
            className={styles.link}
            disabled={navigation.positioning}
            onClick={reader.continueHere}
          >
            continue reading here
          </button>
          <button
            type="button"
            className={styles.quiet}
            onClick={() => setCollapsed(true)}
          >
            keep inspecting
          </button>
        </span>
      ) : null}
      {error ? <span className={styles.error}>{error}</span> : null}
      {handoff ? (
        <span className={styles.choice}>
          <span className={styles.title}>newer reading spot available</span>
          <button
            type="button"
            className={styles.link}
            onClick={() => void reader.resolveHandoff("Canonical")}
          >
            use newer spot
          </button>
          <button
            type="button"
            className={styles.link}
            onClick={() => void reader.resolveHandoff("Device")}
          >
            keep my reading spot
          </button>
        </span>
      ) : null}
      {ready?.saveFailed ? (
        <span className={styles.choice}>
          <span>progress not synced</span>
          <button
            type="button"
            className={styles.link}
            onClick={reader.retrySave}
          >
            retry
          </button>
        </span>
      ) : null}
      {unavailable && !exploring ? (
        <span>saved reading spot unavailable</span>
      ) : null}
    </div>
  );
}
