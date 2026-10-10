"use client";

/**
 * The one citation adapter: `CitationOut` to what `ReaderCitation` renders, and the
 * in-reader jump a citation (or a quoted passage) activates. Chat, Oracle, dossiers
 * and read-resource evidence all flow through here.
 */

import type { Schema } from "@/lib/api/wire";
import type { ResourceActivation } from "@/lib/resources/activation";
import { setPendingNoteActivation } from "@/lib/reader/pendingNoteActivation";
import {
  dispatchNotePulse,
  dispatchReaderPulse,
} from "@/lib/reader/pulseEvent";

/** `media_id` is the jump anchor: for an evidence span, `target_ref.id` is the span. */
export type CitationOut = Schema<"CitationOut">;
export type RetrievalLocator = NonNullable<CitationOut["locator"]>;

/** A span in a media reader, or offsets in a note block (notes are not media). */
export type ReaderSourceTarget = {
  snippet: string | null;
  label?: string;
  href?: string | null;
} & (
  | {
      kind: "media";
      media_id: string;
      locator: RetrievalLocator;
      evidence_span_id?: string | null;
    }
  | { kind: "note"; block_id: string; start_offset: number; end_offset: number }
);

export interface ReaderCitationPreview {
  title?: string;
  excerpt?: string;
  summary?: string;
  meta?: string[];
  copyText?: string;
}

export interface ReaderCitationData {
  index: number;
  preview: ReaderCitationPreview;
  activation: ResourceActivation;
  target: ReaderSourceTarget | null;
}

function citationTarget(c: CitationOut): ReaderSourceTarget | null {
  const shared = {
    snippet: c.snapshot?.excerpt ?? null,
    label: c.snapshot?.title ?? undefined,
    href: c.activation.href,
  };
  const locator = c.locator;
  if (locator?.type === "note_block_offsets") {
    return {
      ...shared,
      kind: "note",
      block_id: locator.block_id,
      start_offset: locator.start_offset,
      end_offset: locator.end_offset,
    };
  }
  if (!locator || !c.media_id) return null;
  const span = c.target_ref.type === "evidence_span" ? c.target_ref.id : null;
  return {
    ...shared,
    kind: "media",
    media_id: c.media_id,
    locator,
    evidence_span_id: span,
  };
}

export function toReaderCitationData(c: CitationOut): ReaderCitationData {
  return {
    index: c.ordinal,
    preview: {
      title: c.snapshot?.title ?? "",
      ...(c.snapshot?.summary_md != null
        ? { summary: c.snapshot.summary_md }
        : {}),
      excerpt: c.snapshot?.excerpt ?? "",
      meta: [c.snapshot?.section_label, c.snapshot?.result_type].filter(
        (v): v is string => Boolean(v),
      ),
    },
    activation: c.activation,
    target: citationTarget(c),
  };
}

/** Jump and pulse: every activation scrolls its span into view and pulses it. */
export function dispatchReaderSourceActivation(
  target: ReaderSourceTarget,
): void {
  const behavior = {
    snippet: target.snippet,
    highlightBehavior: "pulse",
    focusBehavior: "scroll_into_view",
  } as const;
  if (target.kind === "note") {
    const pulse = {
      ...behavior,
      blockId: target.block_id,
      startOffset: target.start_offset,
      endOffset: target.end_offset,
    };
    dispatchNotePulse(pulse);
    setPendingNoteActivation(pulse);
    return;
  }
  dispatchReaderPulse({
    ...behavior,
    mediaId: target.media_id,
    evidenceSpanId: target.evidence_span_id ?? undefined,
    locator: target.locator,
  });
}
