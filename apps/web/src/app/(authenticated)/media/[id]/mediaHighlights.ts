"use client";

import { apiFetch } from "@/lib/api/client";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import { createNoteBlock, deleteNoteBlock } from "@/lib/notes/api";

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
  linked_note_blocks?: {
    note_block_id: string;
    body_pm_json?: Record<string, unknown>;
    body_markdown?: string;
    body_text: string;
  }[];
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
  bodyPmJson: Record<string, unknown>
): Promise<void> {
  await createNoteBlock({
    bodyPmJson,
    linkedObject: { objectType: "highlight", objectId: highlightId },
    relationType: "note_about",
  });
}

export async function deleteHighlightNote(noteBlockId: string): Promise<void> {
  await deleteNoteBlock(noteBlockId);
}
