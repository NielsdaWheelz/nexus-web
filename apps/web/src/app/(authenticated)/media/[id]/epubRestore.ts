import { absent, present, type Presence } from "@/lib/api/presence";
import type {
  ReaderNavigationFragment,
  ReaderNavigationSection,
  ReaderNavigationTextPoint,
} from "@/lib/media/readerNavigation";
import type { EpubReaderResumeState } from "@/lib/reader/types";

export type ReaderRestorePhase =
  | "idle"
  | "resolving"
  | "opening_target"
  | "restoring_exact"
  | "settled"
  | "cancelled";

import type { EpubRestoreRequest } from "@/lib/reader/epubInternalLinks";

export function buildEpubPointRestoreRequest(point: ReaderNavigationTextPoint): EpubRestoreRequest {
  return { fragmentId: point.fragment_id, target: { kind: "Offset", offset: point.offset } };
}

export function buildEpubSectionRestoreRequest(
  section: ReaderNavigationSection,
): EpubRestoreRequest {
  return section.anchor_id.kind === "Present"
    ? { fragmentId: section.target.fragment_id, target: { kind: "Anchor", anchorId: section.anchor_id.value } }
    : buildEpubPointRestoreRequest(section.target);
}

export function resolveInitialEpubRestoreRequest({
  requestedSectionId,
  resumeState,
  fragments,
  sections,
}: {
  requestedSectionId: string | null;
  resumeState: EpubReaderResumeState | null;
  fragments: readonly ReaderNavigationFragment[];
  sections: readonly ReaderNavigationSection[];
}): Presence<EpubRestoreRequest> {
  if (requestedSectionId !== null) {
    const section = sections.find((candidate) => candidate.section_id === requestedSectionId);
    return section ? present(buildEpubSectionRestoreRequest(section)) : absent();
  }
  if (resumeState !== null) {
    const fragment = fragments.find((candidate) => candidate.fragment_id === resumeState.target.fragment_id);
    const offset = resumeState.locations.text_offset;
    if (!fragment) return absent();
    if (offset === null) return resumeState.target.anchor_id.kind === "Present"
      ? present({ fragmentId: fragment.fragment_id, target: { kind: "Anchor", anchorId: resumeState.target.anchor_id.value } })
      : absent();
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > fragment.char_count) return absent();
    return present(buildEpubPointRestoreRequest({ fragment_id: fragment.fragment_id, offset }));
  }
  const first = fragments[0];
  return first ? present(buildEpubPointRestoreRequest({ fragment_id: first.fragment_id, offset: 0 })) : absent();
}
