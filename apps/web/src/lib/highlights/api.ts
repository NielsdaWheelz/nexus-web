"use client";

import { apiFetch, decodeApiPayload, type ApiError } from "@/lib/api/client";
import { expectCanonicalUuid, expectExactRecord } from "@/lib/validation";
import { compareStableString } from "@/lib/display/format";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import {
  decodeHighlightEnvelope,
  decodeHighlightListEnvelope,
  decodeHighlightNoteEnvelope,
  decodeMediaHighlightListEnvelope,
  decodeMediaHighlight,
  type Highlight,
  type HighlightLinkedNoteBlock,
  type MediaHighlight,
} from "@/lib/highlights/highlightContract";

export async function fetchHighlights(
  fragmentId: string,
  signal?: AbortSignal,
): Promise<Highlight[]> {
  const response = await apiFetch<unknown>(
    `/api/fragments/${fragmentId}/highlights`,
    { cache: "no-store", signal },
  );
  return decodeApiPayload(
    response,
    decodeHighlightListEnvelope,
    "Highlight list",
  );
}

export async function fetchHighlight(
  highlightId: string,
  signal: AbortSignal,
): Promise<MediaHighlight> {
  const response = await apiFetch<unknown>(`/api/highlights/${highlightId}`, {
    cache: "no-store",
    signal,
  });
  return decodeApiPayload(response, (raw) => {
    const highlight = decodeMediaHighlight(expectExactRecord(raw, ["data"], "Highlight detail response").data);
    if (highlight.id !== highlightId) {
      throw new TypeError("Highlight detail returned another highlight");
    }
    return highlight;
  }, "Highlight detail");
}

export function conflictingHighlightId(error: ApiError): string | null {
  const details = error.details;
  if (error.code !== "E_HIGHLIGHT_CONFLICT" ||
      details === undefined || !("existing_highlight_id" in details)) return null;
  return decodeApiPayload(details.existing_highlight_id,
    (raw) => expectCanonicalUuid(raw, "existing_highlight_id"),
    "Highlight conflict");
}

export async function fetchMediaHighlights(
  mediaId: string,
): Promise<MediaHighlight[]> {
  const response = await apiFetch<unknown>(
    `/api/media/${mediaId}/highlights?mine_only=false`,
    { cache: "no-store" },
  );
  return decodeApiPayload(
    response,
    decodeMediaHighlightListEnvelope,
    "Media highlight list",
  );
}

/** A null offset (unresolved locator cache) sorts after every resolved one. */
function compareNullableOffset(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/**
 * Total order on text-anchored highlights: anchor start, then anchor end,
 * then created_at, then id. Stable across reads from the API. Unresolved
 * highlights (null offsets) sort after resolved ones at the same tier
 * instead of comparing as `NaN`.
 */
export function compareHighlightsByAnchor(a: Highlight, b: Highlight): number {
  const startOrder = compareNullableOffset(a.anchor.start_offset, b.anchor.start_offset);
  if (startOrder !== 0) return startOrder;
  const endOrder = compareNullableOffset(a.anchor.end_offset, b.anchor.end_offset);
  if (endOrder !== 0) return endOrder;
  if (a.created_at !== b.created_at) {
    return compareStableString(a.created_at, b.created_at);
  }
  return compareStableString(a.id, b.id);
}

/** Replace any prior copy of `highlight` in `list`, then sort by anchor. */
export function upsertHighlightSorted(
  list: Highlight[],
  highlight: Highlight,
): Highlight[] {
  return [...list.filter((h) => h.id !== highlight.id), highlight].sort(
    compareHighlightsByAnchor,
  );
}

export async function createHighlight(
  fragmentId: string,
  startOffset: number,
  endOffset: number,
  color: HighlightColor,
): Promise<Highlight> {
  const response = await apiFetch<unknown>(
    `/api/fragments/${fragmentId}/highlights`,
    {
      method: "POST",
      body: JSON.stringify({
        start_offset: startOffset,
        end_offset: endOffset,
        color,
      }),
    },
  );
  return decodeApiPayload(response, decodeHighlightEnvelope, "Highlight");
}

export async function updateHighlight(
  highlightId: string,
  updates: {
    anchor?: {
      start_offset: number;
      end_offset: number;
    };
    color?: HighlightColor;
  },
): Promise<void> {
  const body: {
    color?: HighlightColor;
    anchor?: {
      type: "fragment_offsets";
      start_offset: number;
      end_offset: number;
    };
  } = {};

  if (updates.color !== undefined) {
    body.color = updates.color;
  }

  if (updates.anchor !== undefined) {
    body.anchor = {
      type: "fragment_offsets",
      start_offset: updates.anchor.start_offset,
      end_offset: updates.anchor.end_offset,
    };
  }

  await apiFetch(`/api/highlights/${highlightId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function deleteHighlight(highlightId: string): Promise<void> {
  await apiFetch(`/api/highlights/${highlightId}`, {
    method: "DELETE",
  });
}

export async function saveHighlightNote(
  highlightId: string,
  noteBlockId: string | null,
  createBlockId: string,
  bodyPmJson: Record<string, unknown>,
  clientMutationId: string,
): Promise<HighlightLinkedNoteBlock> {
  const response = await apiFetch<unknown>(
    `/api/highlights/${highlightId}/note`,
    {
      method: "PUT",
      body: JSON.stringify({
        note_block_id: noteBlockId ?? createBlockId,
        client_mutation_id: clientMutationId,
        body_pm_json: bodyPmJson,
      }),
    },
  );
  return decodeApiPayload(
    response,
    decodeHighlightNoteEnvelope,
    "Highlight note",
  );
}

export async function deleteHighlightNote(
  highlightId: string,
  noteBlockId: string,
  clientMutationId: string,
): Promise<void> {
  const params = new URLSearchParams({
    note_block_id: noteBlockId,
    client_mutation_id: clientMutationId,
  });
  await apiFetch(`/api/highlights/${highlightId}/note?${params.toString()}`, {
    method: "DELETE",
  });
}

export function patchHighlightLinkedNoteBlock<
  T extends { id: string; linked_note_blocks?: HighlightLinkedNoteBlock[] },
>(
  highlights: T[],
  highlightId: string,
  linkedNoteBlock: HighlightLinkedNoteBlock,
): T[] {
  let changed = false;
  const nextHighlights = highlights.map((highlight) => {
    if (highlight.id !== highlightId) {
      return highlight;
    }

    const linkedNoteBlocks = highlight.linked_note_blocks ?? [];
    const existingIndex = linkedNoteBlocks.findIndex(
      (noteBlock) => noteBlock.note_block_id === linkedNoteBlock.note_block_id,
    );
    const nextLinkedNoteBlocks =
      existingIndex >= 0
        ? linkedNoteBlocks.map((noteBlock, index) =>
            index === existingIndex ? linkedNoteBlock : noteBlock,
          )
        : [...linkedNoteBlocks, linkedNoteBlock];

    changed = true;
    return {
      ...highlight,
      linked_note_blocks: nextLinkedNoteBlocks,
    };
  });

  return changed ? nextHighlights : highlights;
}

export function removeHighlightLinkedNoteBlock<
  T extends { id: string; linked_note_blocks?: HighlightLinkedNoteBlock[] },
>(highlights: T[], noteBlockId: string): T[] {
  let changed = false;
  const nextHighlights = highlights.map((highlight) => {
    const linkedNoteBlocks = highlight.linked_note_blocks ?? [];
    const nextLinkedNoteBlocks = linkedNoteBlocks.filter(
      (noteBlock) => noteBlock.note_block_id !== noteBlockId,
    );

    if (nextLinkedNoteBlocks.length === linkedNoteBlocks.length) {
      return highlight;
    }

    changed = true;
    return {
      ...highlight,
      linked_note_blocks: nextLinkedNoteBlocks,
    };
  });

  return changed ? nextHighlights : highlights;
}
