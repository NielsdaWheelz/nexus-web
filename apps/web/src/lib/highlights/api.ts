"use client";

import { apiFetch } from "@/lib/api/client";
import { compareStableString } from "@/lib/display/format";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import type { PdfHighlightQuad } from "@/lib/highlights/pdfTypes";

export interface HighlightLinkedNoteBlock {
  note_block_id: string;
  body_pm_json?: Record<string, unknown>;
  body_text: string;
}

export interface Highlight {
  id: string;
  anchor: {
    type: "fragment_offsets";
    media_id: string;
    fragment_id: string;
    start_offset: number;
    end_offset: number;
  };
  color: HighlightColor;
  exact: string;
  prefix: string;
  suffix: string;
  created_at: string;
  updated_at: string;
  author_user_id: string;
  is_owner: boolean;
  linked_conversations?: { conversation_id: string; title: string }[];
  linked_note_blocks?: HighlightLinkedNoteBlock[];
}

export async function fetchHighlights(
  fragmentId: string,
): Promise<Highlight[]> {
  const response = await apiFetch<{ data: { highlights: Highlight[] } }>(
    `/api/fragments/${fragmentId}/highlights`,
    { cache: "no-store" },
  );
  return response.data.highlights;
}

/** A highlight anchored to a PDF page's geometry, as returned by the API. */
export interface PdfHighlight extends Omit<Highlight, "anchor"> {
  anchor: {
    type: "pdf_page_geometry";
    media_id: string;
    page_number: number;
    quads: PdfHighlightQuad[];
  };
}

/** A highlight from the media-wide endpoint: fragment-offset or PDF-page anchor. */
export type MediaHighlight = Highlight | PdfHighlight;

export async function fetchMediaHighlights(
  mediaId: string,
): Promise<MediaHighlight[]> {
  const response = await apiFetch<{ data: { highlights: MediaHighlight[] } }>(
    `/api/media/${mediaId}/highlights?mine_only=false`,
    { cache: "no-store" },
  );
  return response.data.highlights;
}

/**
 * Total order on text-anchored highlights: anchor start, then anchor end,
 * then created_at, then id. Stable across reads from the API.
 */
export function compareHighlightsByAnchor(a: Highlight, b: Highlight): number {
  if (a.anchor.start_offset !== b.anchor.start_offset) {
    return a.anchor.start_offset - b.anchor.start_offset;
  }
  if (a.anchor.end_offset !== b.anchor.end_offset) {
    return a.anchor.end_offset - b.anchor.end_offset;
  }
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
  const response = await apiFetch<{ data: Highlight }>(
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
  return response.data;
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
  const response = await apiFetch<{ data: HighlightLinkedNoteBlock }>(
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
  return response.data;
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
