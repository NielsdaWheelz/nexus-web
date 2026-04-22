"use client";

import { apiFetch } from "@/lib/api/client";
import type { HighlightColor } from "@/lib/highlights/segmenter";

export interface Highlight {
  id: string;
  fragment_id: string;
  start_offset: number;
  end_offset: number;
  color: HighlightColor;
  exact: string;
  prefix: string;
  suffix: string;
  created_at: string;
  updated_at: string;
  annotation: {
    id: string;
    body: string;
    created_at: string;
    updated_at: string;
  } | null;
  linked_conversations?: { conversation_id: string; title: string }[];
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
    start_offset?: number;
    end_offset?: number;
    color?: HighlightColor;
  }
): Promise<void> {
  const hasStartOffset = typeof updates.start_offset === "number";
  const hasEndOffset = typeof updates.end_offset === "number";

  if (hasStartOffset !== hasEndOffset) {
    throw new Error("Fragment highlight updates require both start_offset and end_offset.");
  }

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

  if (hasStartOffset && hasEndOffset) {
    body.anchor = {
      type: "fragment_offsets",
      start_offset: updates.start_offset as number,
      end_offset: updates.end_offset as number,
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

export async function saveAnnotation(
  highlightId: string,
  body: string
): Promise<void> {
  await apiFetch(`/api/highlights/${highlightId}/annotation`, {
    method: "PUT",
    body: JSON.stringify({ body }),
  });
}

export async function deleteAnnotation(highlightId: string): Promise<void> {
  await apiFetch(`/api/highlights/${highlightId}/annotation`, {
    method: "DELETE",
  });
}
