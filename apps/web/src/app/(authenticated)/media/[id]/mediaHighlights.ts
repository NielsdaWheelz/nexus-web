"use client";

import { apiFetch } from "@/lib/api/client";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import {
  createNoteBlock,
  deleteNoteBlock,
  updateNoteBlock,
  type NoteBlock,
} from "@/lib/notes/api";

export interface HighlightLinkedNoteBlock {
  note_block_id: string;
  body_pm_json?: Record<string, unknown>;
  body_markdown?: string;
  body_text: string;
  revision: number;
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

export async function fetchHighlights(fragmentId: string): Promise<Highlight[]> {
  const response = await apiFetch<{ data: { highlights: Highlight[] } }>(
    `/api/fragments/${fragmentId}/highlights`,
    { cache: "no-store" }
  );
  return response.data.highlights;
}

export async function createHighlight(
  fragmentId: string,
  startOffset: number,
  endOffset: number,
  color: HighlightColor
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
    }
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
  }
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
  baseRevision: number | null
): Promise<HighlightLinkedNoteBlock> {
  const noteBlock = noteBlockId
    ? await updateNoteBlock(noteBlockId, { baseRevision: requiredRevision(baseRevision), bodyPmJson })
    : await createNoteBlock({
        id: createBlockId,
        bodyPmJson,
        linkedObject: { objectType: "highlight", objectId: highlightId },
        relationType: "note_about",
      });
  return noteBlockToHighlightLinkedNoteBlock(noteBlock);
}

export async function deleteHighlightNote(
  noteBlockId: string,
  baseRevision: number
): Promise<void> {
  await deleteNoteBlock(noteBlockId, { baseRevision });
}

export function noteBlockToHighlightLinkedNoteBlock(
  noteBlock: NoteBlock
): HighlightLinkedNoteBlock {
  return {
    note_block_id: noteBlock.id,
    body_pm_json: noteBlock.bodyPmJson,
    body_markdown: noteBlock.bodyMarkdown,
    body_text: noteBlock.bodyText,
    revision: requiredRevision(noteBlock.revision),
  };
}

function requiredRevision(revision: number | null | undefined): number {
  if (typeof revision !== "number" || !Number.isFinite(revision)) {
    throw new Error("Highlight note is missing revision metadata");
  }
  return revision;
}

export function patchHighlightLinkedNoteBlock<
  T extends { id: string; linked_note_blocks?: HighlightLinkedNoteBlock[] },
>(
  highlights: T[],
  highlightId: string,
  linkedNoteBlock: HighlightLinkedNoteBlock
): T[] {
  let changed = false;
  const nextHighlights = highlights.map((highlight) => {
    if (highlight.id !== highlightId) {
      return highlight;
    }

    const linkedNoteBlocks = highlight.linked_note_blocks ?? [];
    const existingIndex = linkedNoteBlocks.findIndex(
      (noteBlock) => noteBlock.note_block_id === linkedNoteBlock.note_block_id
    );
    const nextLinkedNoteBlocks =
      existingIndex >= 0
        ? linkedNoteBlocks.map((noteBlock, index) =>
            index === existingIndex ? linkedNoteBlock : noteBlock
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
      (noteBlock) => noteBlock.note_block_id !== noteBlockId
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
