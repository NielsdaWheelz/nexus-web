"use client";

import { apiFetch } from "@/lib/api/client";
import { decodePresence, type Presence } from "@/lib/api/presence";
import { useResource, type AsyncResource } from "@/lib/api/useResource";
import {
  expectExactRecord,
  expectCanonicalUuid,
  expectBoundedInteger,
  expectOneOf,
  expectRecord,
  isCanonicalUuid,
} from "@/lib/validation";

export type PassageTarget =
  | { kind: "NoteTextOffsets"; startOffset: number; endOffset: number }
  | { kind: "FragmentTextOffsets"; fragmentId: string; startOffset: number; endOffset: number }
  | { kind: "TimeRange"; startMs: number; endMs: number }
  | { kind: "PdfPage"; pageNumber: number };

function offsets(row: Record<string, unknown>, name: string) {
  const startOffset = expectBoundedInteger(row.start_offset, `${name}.start_offset`, 0, 2 ** 31 - 1);
  const endOffset = expectBoundedInteger(row.end_offset, `${name}.end_offset`, 0, 2 ** 31 - 1);
  if (startOffset >= endOffset) throw new TypeError(`${name} offsets must form a non-empty range`);
  return { startOffset, endOffset };
}

function decodeTarget(raw: unknown, ownerScheme: "media" | "note_block"): PassageTarget {
  const value = expectRecord(raw, "passage target");
  const kind = expectOneOf(value.kind, ["NoteTextOffsets", "FragmentTextOffsets", "TimeRange", "PdfPage"] as const, "passage target.kind");
  if (kind === "NoteTextOffsets") {
    if (ownerScheme !== "note_block") throw new TypeError("media passage cannot resolve to note offsets");
    const row = expectExactRecord(value, ["kind", "start_offset", "end_offset"], "passage target");
    return { kind, ...offsets(row, "passage target") };
  }
  if (ownerScheme !== "media") throw new TypeError("note passage cannot resolve to a media target");
  if (kind === "FragmentTextOffsets") {
    const row = expectExactRecord(value, ["kind", "fragment_id", "start_offset", "end_offset"], "passage target");
    const fragmentId = expectCanonicalUuid(row.fragment_id, "passage target.fragment_id");
    return { kind, fragmentId, ...offsets(row, "passage target") };
  }
  if (kind === "TimeRange") {
    const row = expectExactRecord(value, ["kind", "start_ms", "end_ms"], "passage target");
    const startMs = expectBoundedInteger(row.start_ms, "passage target.start_ms", 0, Number.MAX_SAFE_INTEGER);
    const endMs = expectBoundedInteger(row.end_ms, "passage target.end_ms", 0, Number.MAX_SAFE_INTEGER);
    if (startMs >= endMs) throw new TypeError("passage target time range must be non-empty");
    return { kind, startMs, endMs };
  }
  const row = expectExactRecord(value, ["kind", "page_number"], "passage target");
  return {
    kind,
    pageNumber: expectBoundedInteger(row.page_number, "passage target.page_number", 1, 2 ** 31 - 1),
  };
}

export function passageAnchorIdFromHash(hash: string): string | null {
  const match = /^#passage-([0-9a-f-]+)$/i.exec(hash);
  return match && isCanonicalUuid(match[1]) ? match[1] : null;
}

export function usePassageResolution(input: {
  hash: string;
  ownerScheme: "media" | "note_block";
  ownerId: string;
}): AsyncResource<Presence<PassageTarget>> {
  const anchorId = passageAnchorIdFromHash(input.hash);
  const ownerRef = `${input.ownerScheme}:${input.ownerId}`;
  const key = anchorId ? `${anchorId}:${ownerRef}` : null;
  return useResource({
    cacheKey: key,
    load: async (signal: AbortSignal) => {
      if (!anchorId) throw new Error("Cannot resolve a missing passage anchor");
      const raw = await apiFetch<unknown>(
        `/api/passage-anchors/${encodeURIComponent(anchorId)}/resolution?owner_ref=${encodeURIComponent(ownerRef)}`,
        { signal },
      );
      const envelope = expectExactRecord(raw, ["data"], "passage resolution response");
      return decodePresence(envelope.data, (target) => decodeTarget(target, input.ownerScheme));
    },
  });
}
