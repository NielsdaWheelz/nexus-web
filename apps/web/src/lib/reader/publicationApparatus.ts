import type { CanonicalCursorResult } from "@/lib/highlights/canonicalCursor";
import type { PdfHighlightQuad } from "@/lib/highlights/pdfTypes";
import { escapeAttrValue } from "@/lib/highlights/escapeAttrValue";
import { scrollToExactCanonicalTextAnchor } from "@/app/(authenticated)/media/[id]/paneTextAnchor";
import type { DocumentReaderSession, ReaderUnitLease, ReaderViewCapacity } from "./DocumentReaderSession";
import type { ReaderPublicationSourceRange, ReaderPublicationTarget, ReaderPublicationUnit } from "./publicationContract";
import type { DocumentReaderWindow, ReaderWindowUnit } from "./useDocumentReaderWindow";
import type { ReaderScrollPositioner } from "./paneScroll";
import type { ReaderPublicationEvidenceMarkerTarget } from "./readerPublicationOverlays";
import type { ReaderResumeState } from "./types";

interface PublicationPositioner {
  readonly signal: AbortSignal;
  readonly commandIsCurrent: () => boolean;
  readonly navigate: DocumentReaderWindow["navigate"];
  readonly waitForUnit: (item: ReaderWindowUnit, signal: AbortSignal) => Promise<null | ReaderViewCapacity | { readonly kind: "Failed"; readonly error: unknown }>;
  readonly getRenderedUnit: (lease: ReaderUnitLease) => {
    readonly root: HTMLElement; readonly viewport: HTMLElement;
    readonly cursor: CanonicalCursorResult; readonly unit: ReaderPublicationUnit;
  } | null;
  readonly scrollPositioner: ReaderScrollPositioner;
  readonly pulse: (element: HTMLElement) => void;
  readonly reportMovement: (locator: ReaderResumeState) => void | Promise<void>;
}

/** Position an admitted source range and capture only while its navigation is current. */
export function positionPublicationRange({ range, stableKey, locator, pulseRange, ...positioner }: PublicationPositioner & {
  readonly range: ReaderPublicationSourceRange;
  readonly stableKey: string | null;
  readonly locator?: Extract<ReaderResumeState, { kind: "web" | "epub" }>;
  readonly pulseRange?: (range: ReaderPublicationSourceRange) => Promise<boolean | ReaderViewCapacity>;
}) {
  return positionPublication({ ...positioner, range, stableKey, locator, pulseRange, target: { kind: "Unit", unit_key: range.unit_key } });
}

/** A section/href command preserves the locator returned by its exact retained target. */
export function positionPublicationTarget({ target, ...positioner }: PublicationPositioner & {
  readonly target: Extract<ReaderPublicationTarget, { readonly kind: "Navigation" | "EpubHref" }>;
}) {
  return positionPublication({ ...positioner, range: null, stableKey: null, target });
}

export function positionPublicationEmbed({ target, ...positioner }: PublicationPositioner & {
  readonly target: Extract<ReaderPublicationEvidenceMarkerTarget, { kind: "Embed" }>;
}) {
  return positionPublication({ ...positioner, range: null, stableKey: null, embed: target,
    target: { kind: "Unit", unit_key: target.unit_key } });
}

async function positionPublication({ range: requestedRange, target, stableKey, embed, locator, pulseRange, signal, commandIsCurrent,
  navigate, waitForUnit, getRenderedUnit, scrollPositioner, pulse, reportMovement }: PublicationPositioner & {
  readonly range: ReaderPublicationSourceRange | null;
  readonly target: ReaderPublicationTarget;
  readonly embed?: Extract<ReaderPublicationEvidenceMarkerTarget, { kind: "Embed" }>;
  readonly locator?: Extract<ReaderResumeState, { kind: "web" | "epub" }>;
  readonly pulseRange?: (range: ReaderPublicationSourceRange) => Promise<boolean | ReaderViewCapacity>;
  readonly stableKey: string | null;
}): Promise<{ readonly kind: "Located" | "Unavailable" } | ReaderViewCapacity> {
  signal.throwIfAborted();
  if (!commandIsCurrent()) return { kind: "Unavailable" };
  let lease: ReaderUnitLease;
  let isCurrent: () => boolean;
  let range: ReaderPublicationSourceRange;
  let targetLocator: ReaderResumeState | null = locator ?? null;
  let releaseNavigation: (() => void) | null = null;
  try {
    {
      const completion = await navigate(target);
      signal.throwIfAborted();
      if (!commandIsCurrent()) return { kind: "Unavailable" };
      if (completion.kind === "Failed") throw completion.error;
      if (completion.kind !== "Ready") return completion.kind === "Capacity" ? completion : { kind: "Unavailable" };
      if (!completion.isCurrent()) return { kind: "Unavailable" };
      lease = completion.item.lease;
      releaseNavigation = lease.holdNavigation();
      if (requestedRange !== null) range = requestedRange;
      else if (embed !== undefined) {
        const occurrence = completion.item.unit.document_embeds.find((item) => item.id === embed.id && item.occurrence_key === embed.occurrence_key && item.ordinal === embed.ordinal);
        if (occurrence === undefined) throw new Error("Embed marker escaped its retained source unit");
        if (occurrence.canonical_start_offset === null || occurrence.canonical_end_offset === null) throw new Error("Positioned embed has no canonical source point");
        range = { unit_key: completion.item.address.unit_ref.key, fragment_id: completion.item.unit.fragment_id,
          start_cp: occurrence.canonical_start_offset, end_cp: occurrence.canonical_end_offset };
      } else {
        if (completion.target.kind !== "Text" || completion.target.locator.locations.text_offset === null) {
          throw new Error("Retained navigation did not resolve an exact source point");
        }
        targetLocator = completion.target.locator;
        range = { unit_key: completion.item.address.unit_ref.key, fragment_id: completion.item.unit.fragment_id,
          start_cp: completion.target.locator.locations.text_offset, end_cp: completion.target.locator.locations.text_offset };
      }
      const navigationIsCurrent = completion.isCurrent;
      isCurrent = () => commandIsCurrent() && navigationIsCurrent();
      const prepared = await waitForUnit(completion.item, signal);
      signal.throwIfAborted();
      if (!isCurrent()) return { kind: "Unavailable" };
      if (prepared?.kind === "Failed") throw prepared.error;
      if (prepared !== null) return prepared;
    }
    let positioned = false;
    await scrollPositioner.run((commands) => {
      signal.throwIfAborted();
      if (!isCurrent()) return;
      const prepared = getRenderedUnit(lease);
      if (prepared === null || !prepared.root.isConnected) return;
      const { unit, root, viewport, cursor } = prepared;
      if (unit.fragment_id !== range.fragment_id || range.start_cp < unit.start_cp || range.start_cp > unit.end_cp) {
        throw new Error("Source note location escaped its retained unit");
      }
      const marker = embed !== undefined
        ? root.querySelector<HTMLElement>(`[data-nexus-document-embed-id="${escapeAttrValue(embed.occurrence_key)}"]`)
        : stableKey === null ? null : root.querySelector<HTMLElement>(`[data-reader-apparatus-item-id="${escapeAttrValue(stableKey)}"]`);
      if (marker !== null) { commands.reveal(viewport, marker); pulse(marker); }
      else if (cursor.length === 0) commands.reveal(viewport, root);
      else if (!scrollToExactCanonicalTextAnchor(commands, viewport, cursor, Math.max(0, range.start_cp - unit.render_start_cp))) {
        throw new Error("Source note could not be positioned at its canonical offset");
      }
      positioned = true;
    });
    signal.throwIfAborted();
    if (!positioned || !isCurrent()) return { kind: "Unavailable" };
    if (pulseRange !== undefined) {
      const pulsed = await pulseRange(range);
      signal.throwIfAborted();
      if (!isCurrent() || pulsed === false) return { kind: "Unavailable" };
      if (pulsed !== true) return pulsed;
    }
    let capture: void | Promise<void>;
    {
      const prepared = getRenderedUnit(lease);
      if (prepared === null || !prepared.root.isConnected) return { kind: "Unavailable" };
      const { unit } = prepared;
      const position = { locations: { text_offset: range.start_cp, progression: null, total_progression: null, position: null },
        text: { quote: null, quote_prefix: null, quote_suffix: null } };
      capture = reportMovement(targetLocator ?? (unit.epub_target === null
        ? { kind: "web", target: { fragment_id: unit.fragment_id }, ...position }
        : { kind: "epub", target: unit.epub_target, ...position }));
    }
    await capture;
    signal.throwIfAborted();
    return { kind: isCurrent() ? "Located" : "Unavailable" };
  } finally { releaseNavigation?.(); }
}

/** A source-note command owns its location until positioning and source-bound capture settle. */
export async function locatePublicationApparatus({ session, itemId, stableKey, signal, commandIsCurrent,
  navigate, waitForUnit, getRenderedUnit, scrollPositioner, pulse, reportMovement, locatePdf }: PublicationPositioner & {
  readonly session: DocumentReaderSession;
  readonly itemId: string;
  readonly stableKey: string;
  readonly locatePdf: ((page: number, quads: readonly PdfHighlightQuad[], signal: AbortSignal) => Promise<boolean>) | null;
}): Promise<{ readonly kind: "Located" | "Unavailable" } | ReaderViewCapacity> {
  signal.throwIfAborted();
  if (!commandIsCurrent()) return { kind: "Unavailable" };
  if (session.overlays === null) throw new Error("Hosted reader apparatus capability is unavailable");
  const response = await session.overlays({ kind: "ApparatusLocation", itemId }, signal);
  if (response.kind === "Capacity") {
    signal.throwIfAborted();
    return commandIsCurrent() ? response : { kind: "Unavailable" };
  }
  const locationLease = response.lease;
  try {
    signal.throwIfAborted();
    if (!commandIsCurrent()) return { kind: "Unavailable" };
    if (locationLease.result.kind !== "ApparatusLocation") throw new Error("Source note location received another overlay");
    const location = locationLease.result.page;
    if (location.kind === "Unavailable") return { kind: "Unavailable" };
    if (location.kind === "Pdf") {
      if (locatePdf === null) return { kind: "Unavailable" };
      const located = await locatePdf(location.page, location.quads, signal);
      signal.throwIfAborted();
      return { kind: located && commandIsCurrent() ? "Located" : "Unavailable" };
    }
    return await positionPublicationRange({ range: location.range, stableKey, signal, commandIsCurrent,
      navigate, waitForUnit, getRenderedUnit, scrollPositioner, pulse, reportMovement });
  } finally { locationLease.release(); }
}

/** The selected fact's exact location stays charged until its local navigation retires. */
export async function locatePublicationEvidence({ session, factId, signal, commandIsCurrent,
  navigate, waitForUnit, getRenderedUnit, scrollPositioner, pulse, reportMovement, locatePdf, locatePdfPage }: PublicationPositioner & {
  readonly session: DocumentReaderSession;
  readonly factId: string;
  readonly locatePdf: ((page: number, quads: readonly PdfHighlightQuad[], signal: AbortSignal) => Promise<boolean>) | null;
  readonly locatePdfPage: ((page: number, signal: AbortSignal) => Promise<boolean>) | null;
}): Promise<{ readonly kind: "Located" | "Unavailable" } | ReaderViewCapacity> {
  signal.throwIfAborted();
  if (!commandIsCurrent()) return { kind: "Unavailable" };
  if (session.overlays === null) throw new Error("Hosted reader evidence capability is unavailable");
  const response = await session.overlays({ kind: "EvidenceLocation", request: { fact_id: factId } }, signal);
  if (response.kind === "Capacity") {
    signal.throwIfAborted();
    return commandIsCurrent() ? response : { kind: "Unavailable" };
  }
  const lease = response.lease;
  try {
    signal.throwIfAborted();
    if (!commandIsCurrent()) return { kind: "Unavailable" };
    if (lease.result.kind !== "EvidenceLocation") throw new Error("Evidence location received another overlay");
    const { location } = lease.result.page;
    if (location.kind === "Unavailable" || location.kind === "Document") return { kind: "Unavailable" };
    if (location.kind === "Text") return await positionPublicationRange({ range: location.range, stableKey: null,
      signal, commandIsCurrent, navigate, waitForUnit, getRenderedUnit, scrollPositioner, pulse, reportMovement });
    const positioned = location.kind === "PdfGeometry"
      ? await locatePdf?.(location.page, location.quads, signal)
      : await locatePdfPage?.(location.page, signal);
    signal.throwIfAborted();
    return { kind: positioned === true && commandIsCurrent() ? "Located" : "Unavailable" };
  } finally { lease.release(); }
}
