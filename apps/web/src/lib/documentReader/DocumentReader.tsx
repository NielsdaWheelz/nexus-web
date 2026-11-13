"use client";
import { readerSurfaceStyle } from "@/lib/reader/typography";
import type { CommandVerb, Line, Verb, Verbs } from "@/components/feedback/stage";
import type { ExcerptBody } from "@nexus/authored/excerpt";

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
  type ReactElement,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { useOutcome } from "@/components/feedback/Feedback";
import { useActiveRegion } from "@/components/feedback/stage";
import { Fact } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import Button from "@/components/ui/Button";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import type { Schema } from "@/lib/api/wire";
import { useFailedReadRepair } from "@/lib/api/serverState";
import { targetOfLocator, type HighlightColor, type PdfQuad, type ReaderDocument, type TextUnit } from "./model";
import PdfSurface from "./pdf/PdfSurface";
import {
  createReaderRuntime,
  type Reader,
  type ReaderOptions,
  type ReaderRuntime,
  type ReaderState,
} from "./runtime";
import TextSurface from "./text/TextSurface";
import { unresolvedPosition, type SaveFailure } from "./progress";
import styles from "./documentReader.module.css";
import type { ReaderDestination } from "./location";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import { navigationFailureLine } from "./navigationFeedback";

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
  | { readonly kind: "Captured"; readonly anchor: DraftAnchor; readonly quote: string; readonly excerpt: ExcerptBody | null; readonly excerpt_start: number | null; readonly excerpt_end: number | null }
  | { readonly kind: "Rejected"; readonly reason: "CrossUnit" | "CrossPage" | "UnsupportedExcerpt" | "PartialTable" };
/** Why a selection can't become a highlight here: one line per rejection, for every reader host. */
export function rejectedSelectionFact(reason: Extract<SelectionCandidate, { kind: "Rejected" }>["reason"], doc: ReaderDocument | null): string {
  switch (reason) {
    case "PartialTable": return "select the whole table to quote it.";
    case "UnsupportedExcerpt": return "nexus can’t capture some text in this passage.";
    case "CrossPage": return "highlights can’t cross pages.";
    case "CrossUnit": return doc?.kind === "text" && doc.units.some(unit => unit.xPost !== null) ? "highlights can’t cross posts." : "highlights can’t cross sections.";
  }
}
export type SelectionEvent = SelectionCandidate & {
  readonly identity: string;
  readonly input: "pointer" | "keyboard" | "touch";
};
export type SelectionCapture = Extract<SelectionEvent, { readonly kind: "Captured" }>;
export type SelectionNotice =
  | { readonly kind: "Observed"; readonly selection: SelectionEvent | null; readonly inputHeld: boolean }
  | { readonly kind: "Admitted"; readonly selection: SelectionEvent };
export interface PassageGeometry {
  readonly rect: DOMRect;
  /** Source order, before clipping or visual sorting; first/last retain the actual endpoints. */
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
  /** Passive source position; never a reader navigation command. */
  readonly playback: { readonly identity: string; readonly unit: string; readonly warm: boolean } | null;
  readonly decorations?: Decorations;
  /** The composing passage, independent of the saved decoration map. */
  readonly activePassage?: Passage | null;
  readonly inspection?: Inspection | null;
  /** Absent: selection is inert. */
  readonly onSelection?: (notice: SelectionNotice) => void;
  readonly onMarks?: (event: MarkEvent) => void;
  readonly onApparatus?: (
    key: string,
    rect: DOMRect,
    kind: "activate" | "hover",
    intent: OpenIntent | null,
  ) => void;
  readonly apparatusDestination?: (key: string) => ReaderDestination | null;
  readonly onSeekTime?: (ms: number) => void;
  readonly renderEmbed?: (embedId: string) => ReactNode;
  readonly renderPostActions?: (unit: TextUnit) => ReactNode;
  /** Authenticated hosts render ordinary citations outside the publication text. */
  readonly renderCitation?: (citation: Schema<"CitationOut">) => ReactNode;
  /** false when the host already presents the source title; capture facts remain. */
  readonly showCaptureTitle?: boolean;
  /** Host content preceding publication content. */
  readonly before?: ReactNode;
  /** The host's own words for its publication's failed read, which only it can classify; null,
   * or absent, and the reader says it couldn't open the document. */
  readonly failure?: (error: unknown, retry: { readonly run: () => void; readonly busy: boolean }) => ReactNode;
  /** The port's read failure, including its transport-specific remedy. */
  readonly loadFailure?: (error: unknown, retry: CommandVerb) => { readonly line: Line; readonly verbs: Verbs | null };
  /** The port's save failure. The reader owns the explicit retry and keeps later movement. */
  readonly saveFailure?: (failure: SaveFailure, retry: CommandVerb) => { readonly line: Line; readonly verbs: Verbs | null };
  /** The host's durable facts about this reading, in the reader's status lane beside its own.
   * The reader re-anchors when the lane changes height, so the text under the eye stays put. */
  readonly lane?: ReactNode;
  readonly end?: ReactNode;
}

/** A new reader per key; readability owns mounting and progress commits.
 * observationDemand separately admits passive repair and foreground catch-up. */
export function useDocumentReader(
  key: string,
  options: ReaderOptions,
  enabled = true,
  observationDemand = enabled,
): Reader {
  const current = useRef<{ key: string; runtime: ReaderRuntime } | null>(null);
  if (current.current?.key !== key) {
    current.current = { key, runtime: createReaderRuntime(options) };
  }
  const { runtime } = current.current;
  const observing = enabled && observationDemand;
  const liveObservation = useRef(observing);
  liveObservation.current = observing;
  const observedOnce = useRef(false);
  const publication = useReaderState(runtime, state => state.document);
  const progress = useReaderState(runtime, state => state.progress);
  useFailedReadRepair(observing && (publication.status === "failed" || publication.status === "ready" && publication.refreshFailed),
    publication.status === "loading" || (publication.status === "failed" ? publication.retrying : publication.refreshing), () => {
      if (liveObservation.current && document.visibilityState === "visible") runtime.retryLoad();
    });
  useFailedReadRepair(observing && (progress?.kind === "LoadFailed" || progress?.kind === "Ready" && progress.observation !== null),
    progress?.kind === "Loading" || !!progress && (progress.kind === "LoadFailed" || progress.kind === "Ready") && progress.retrying, () => {
      if (liveObservation.current && document.visibilityState === "visible") runtime.revalidate();
    });
  useEffect(() => {
    if (!enabled) return;
    observedOnce.current = false;
    const unmount = runtime.mount();
    const blur = () => runtime.away(false);
    const hide = () => runtime.away(true);
    const visibility = () => { if (document.visibilityState === "hidden") hide(); };
    const events: [Window | Document, string, () => void][] = [
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
  useEffect(() => {
    if (!observing) return;
    const revalidate = () => {
      if (!liveObservation.current || document.visibilityState !== "visible") return;
      const state = runtime.getState();
      if (state.document.status === "failed" || state.document.status === "ready" && state.document.refreshFailed
        || state.progress?.kind === "LoadFailed" && state.progress.recovery === "ReloadDocument") runtime.retryLoad();
      else runtime.revalidate();
    };
    // Mount/start owns the first position read; renewed demand checks it once.
    if (observedOnce.current) revalidate();
    observedOnce.current = true;
    const events: [Window | Document, string, () => void][] = [
      [window, "focus", revalidate],
      [window, "pageshow", revalidate],
      [window, "online", revalidate],
      [document, "visibilitychange", revalidate],
    ];
    for (const [target, name, listener] of events) target.addEventListener(name, listener);
    return () => { for (const [target, name, listener] of events) target.removeEventListener(name, listener); };
  }, [observing, runtime]);
  return runtime;
}

export function useReaderState<T>(
  reader: Reader,
  select: (state: ReaderState) => T,
): T {
  const read = () => select(reader.getState());
  return useSyncExternalStore(reader.subscribe, read, read);
}

export default function DocumentReaderView(
  props: DocumentReaderViewProps,
): ReactElement {
  // Every Reader is the runtime useDocumentReader made.
  const runtime = props.reader as ReaderRuntime;
  const publication = useReaderState(runtime, (state) => state.document);
  const navigationFailure = useReaderState(runtime, (state) => state.navigation.failure);
  const tracked = useReaderState(runtime, (state) => state.progress !== null);
  const frame = useRef<HTMLDivElement>(null);
  const scrollIndicator = useRef<HTMLDivElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const returnFocus = useCallback(
    () => frame.current?.querySelector<HTMLElement>("[data-pane-content]") ?? frame.current,
    [],
  );
  useActionFocusRecovery(frame, returnFocus);
  const speak = useActiveRegion();
  const { say } = useOutcome();
  // A failed navigation is a one-off miss; a later attempt retires it, and so its slip.
  useEffect(() => navigationFailure ? say(navigationFailureLine(navigationFailure)) : undefined, [navigationFailure, say]);
  let body: ReactNode;
  if (publication.status === "loading") {
    body = (
      <div className={`${styles.feedback} ${styles.readerState} ${styles.readerPitch}`}>
        {props.before}
        <Ruling />
      </div>
    );
  } else if (publication.status === "failed") {
    const retry = { run: runtime.retryLoad, busy: publication.retrying };
    body = (
      <div className={`${styles.feedback} ${styles.readerState}`}>
        {props.before}
        {props.failure?.(publication.error, retry)
          ?? <Fact line={{ fact: "couldn’t open this document." }} verbs={[{ ...retry, label: "retry", commandKey: "RetryDocument" }]} speak={speak} />}
      </div>
    );
  } else if (publication.doc.kind === "pdf") {
    body = (
      <PdfSurface
        runtime={runtime}
        doc={publication.doc}
        view={props}
        scrollIndicator={scrollIndicator}
        feedback={feedback}
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
        feedback={feedback}
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
      <div ref={feedback} className={`${styles.statusStack} ${styles.feedback}`}>
        {tracked ? <StatusStrip reader={runtime} speak={speak} saveFailure={props.saveFailure} loadFailure={props.loadFailure} returnFocus={returnFocus} /> : null}
        {props.lane}
      </div>
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

/** The reading position's lane: at most one fact per condition, each with the verbs that settle it. */
function StatusStrip({ reader, speak, saveFailure, loadFailure, returnFocus }: {
  readonly reader: Reader;
  readonly speak: boolean;
  readonly saveFailure: DocumentReaderViewProps["saveFailure"];
  readonly loadFailure: DocumentReaderViewProps["loadFailure"];
  readonly returnFocus: () => HTMLElement | null;
}) {
  const navigation = useReaderState(reader, (state) => state.navigation);
  const progress = useReaderState(reader, (state) => state.progress);
  const documentReady = useReaderState(reader, (state) => state.document.status === "ready");
  const documentRefreshing = useReaderState(reader, (state) => state.document.status === "ready" && state.document.refreshing);
  const unavailable = useReaderState(reader, (state) => state.savedSpotUnavailable);
  const label = useReaderState(reader, originLabel);
  const exploring = navigation.mode === "Exploring";
  const ready = progress?.kind === "Ready" ? progress : null;
  const unresolved = ready ? unresolvedPosition(ready.view) : null;
  const handoff = unresolved || ready?.observation ? null : ready?.handoff ?? null;
  const unknown = ready?.observation?.acceptance === "Unknown";
  const loadFailed = documentReady && progress?.kind === "LoadFailed" ? progress : null;
  if (!unresolved && !exploring && !handoff && !ready?.saveFailure && !unavailable && !loadFailed && !unknown && !ready?.movementPaused) return null;
  const readFromHere = (busy: boolean): Verb => ({ label: "read from here", commandKey: "ReadFromHere", run: reader.continueHere, busy });
  const retrySave: CommandVerb = { label: "retry", commandKey: "RetryPositionSave", run: reader.retrySave, busy: !!ready && (ready.saving || ready.retrying) };
  const saveFailed = ready?.saveFailure ? saveFailure?.(ready.saveFailure, retrySave)
    ?? { line: { fact: "your reading position isn’t saving.", reason: "this tab still holds it." }, verbs: [retrySave] } : null;
  const positionLoad: { readonly line: Line; readonly verbs: Verbs | null } | null = loadFailed?.recovery === "RetryPosition" ? loadFailure?.(loadFailed.error,
    { label: "retry", commandKey: "RetryPositionLoad", run: reader.revalidate, busy: loadFailed.retrying || documentRefreshing })
    ?? { line: { fact: "couldn’t load your reading position.", reason: "it won’t save until it loads." },
      verbs: [{ label: "retry", commandKey: "RetryPositionLoad", run: reader.revalidate, busy: loadFailed.retrying || documentRefreshing }] } : null;
  return (
    <div className={styles.status} role="group" aria-label="reading position">
      {unresolved ? <>
        <Fact line={{ fact: "your saved reading position no longer matches this version." }} speak={speak}
          verbs={[readFromHere(documentRefreshing || !!ready?.saving || navigation.positioning)]} />
        <details><summary>show previous passage</summary><p className={styles.previousPassage}>{unresolved.excerpt}</p></details>
      </> : exploring && navigation.originUnavailable ? (
        <Fact line={{ fact: "your held place isn’t in this version." }} speak={speak} verbs={[readFromHere(navigation.positioning)]} />
      ) : exploring && navigation.origin ? (
        <Fact line={{ fact: "you’re away from your place.", reason: label ? `it’s held at ${label}.` : "it’s held." }} speak={speak} verbs={[
          { label: "return", commandKey: "ReturnToPlace", run: () => void reader.returnToSpot(), busy: navigation.positioning },
          readFromHere(navigation.positioning),
        ]} />
      ) : exploring ? <ReadingOptions reader={reader} speak={speak} returnFocus={returnFocus} /> : null}
      {handoff ? (
        <Fact line={{ fact: "your reading position changed elsewhere." }} speak={speak} verbs={[
          { label: "go there", commandKey: "AdoptCanonicalPosition", run: () => void reader.resolveHandoff("Canonical"), busy: !!ready?.saving },
          { label: "stay here", commandKey: "KeepDevicePosition", run: () => void reader.resolveHandoff("Device"), busy: !!ready?.saving },
        ]} />
      ) : null}
      {saveFailed ? <Fact line={saveFailed.line} speak={speak} verbs={saveFailed.verbs ?? undefined} /> : null}
      {unavailable && !exploring && !unresolved ? (
        <Fact line={{ fact: "your saved reading position no longer matches this version." }} speak={speak} />
      ) : null}
      {ready?.movementPaused && !unknown ? <Fact line={{ fact: "your reading position isn’t saving.", reason: "this tab still holds it." }} speak={speak}
        verbs={[retrySave]} /> : null}
      {unknown ? <Fact line={{ fact: "not sure your reading position saved.", reason: "this tab still holds it." }} speak={speak}
        verbs={[{ label: "check", commandKey: "CheckPosition", run: reader.revalidate, busy: ready?.retrying }]} /> : null}
      {loadFailed ? loadFailed.recovery === "RetryPosition"
        ? positionLoad && <Fact line={positionLoad.line} verbs={positionLoad.verbs ?? undefined} speak={speak} />
        : <Fact line={{ fact: "your reading position isn’t saving." }} speak={speak}
          verbs={[{ label: "reload document", commandKey: "ReloadDocument", run: reader.retryLoad, busy: loadFailed.retrying || documentRefreshing }]} />
        : null}
    </div>
  );
}

/** A host's cold region before its reader mounts: the ruling at the reader's line pitch. */
export function ReaderRuling({ profile }: { readonly profile: Schema<"ReaderProfileOut"> }) {
  return <div className={styles.readerPitch} style={readerSurfaceStyle(profile)}><Ruling /></div>;
}

/** A first deep link has no earlier cursor to return to. Adoption remains explicit. */
function ReadingOptions({ reader, speak, returnFocus }: { readonly reader: Reader; readonly speak: boolean; readonly returnFocus: () => HTMLElement | null }) {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const positioning = useReaderState(reader, (state) => state.navigation.positioning);
  return (
    <div className={styles.choice}>
      <Fact line={{ fact: "you opened a linked passage.", reason: "your reading position hasn’t moved." }} speak={speak} />
      <Button aria-expanded={anchor !== null} aria-controls={id} onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}>
        reading options
      </Button>
      <FloatingActionSurface open={anchor !== null} anchor={anchor} id={id} disclosure role="group" label="reading options" align="start" placement="below" flip onDismiss={() => setAnchor(null)}>
        <Button aria-busy={positioning || undefined} aria-disabled={positioning || undefined} onClick={(event) => {
          if (positioning) return;
          // reading from here ends exploring, which takes this popover and its trigger: focus
          // they held goes to the text. the popover is portaled, so the frame's recovery can't see it.
          const held = document.activeElement === event.currentTarget;
          flushSync(reader.continueHere);
          if (held && document.activeElement === document.body) returnFocus()?.focus({ preventScroll: true });
        }}>
          read from here
        </Button>
      </FloatingActionSurface>
    </div>
  );
}
