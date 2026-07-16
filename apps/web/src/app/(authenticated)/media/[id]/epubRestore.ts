/**
 * EPUB resume-target resolution.
 *
 * Pure helpers that decide which section, anchor, and locator the reader
 * should restore to given the persisted resume state, the URL-requested
 * section, and the current section list.
 */

import type { ReaderNavigationSection } from "@/lib/media/readerNavigation";
import type {
  EpubReaderResumeState,
  ReaderResumeLocations,
  ReaderResumeTextContext,
} from "@/lib/reader/types";

export type ReaderRestorePhase =
  | "idle"
  | "resolving"
  | "opening_target"
  | "restoring_exact"
  | "restoring_fallback"
  | "settled"
  | "cancelled";

type EpubRestoreSource =
  | "initial_url"
  | "resume_target"
  | "resume_total_progression"
  | "resume_position"
  | "default"
  | "manual_section";

export type EpubRestoreRequest = {
  sectionId: string;
  anchorId: string | null;
  locations: ReaderResumeLocations;
  text: ReaderResumeTextContext;
  source: EpubRestoreSource;
  allowSectionTopFallback: boolean;
};

const EMPTY_LOCATIONS: ReaderResumeLocations = {
  text_offset: null,
  progression: null,
  total_progression: null,
  position: null,
};

const EMPTY_TEXT_CONTEXT: ReaderResumeTextContext = {
  quote: null,
  quote_prefix: null,
  quote_suffix: null,
};

function buildEmptyRequest(
  sectionId: string,
  source: EpubRestoreSource,
  anchorId: string | null,
  allowSectionTopFallback = true,
): EpubRestoreRequest {
  return {
    sectionId,
    anchorId,
    locations: EMPTY_LOCATIONS,
    text: EMPTY_TEXT_CONTEXT,
    source,
    allowSectionTopFallback,
  };
}

function cloneLocations(
  locations: ReaderResumeLocations,
): ReaderResumeLocations {
  return {
    text_offset: locations.text_offset,
    progression: locations.progression,
    total_progression: locations.total_progression,
    position: locations.position,
  };
}

function cloneTextContext(
  text: ReaderResumeTextContext,
): ReaderResumeTextContext {
  return {
    quote: text.quote,
    quote_prefix: text.quote_prefix,
    quote_suffix: text.quote_suffix,
  };
}

function buildResumeRequest(
  sectionId: string,
  source: EpubRestoreSource,
  resumeState: EpubReaderResumeState | null,
  anchorIdOverride: string | null,
): EpubRestoreRequest {
  if (!resumeState || resumeState.target.section_id !== sectionId) {
    return buildEmptyRequest(sectionId, source, anchorIdOverride);
  }

  return {
    sectionId,
    anchorId: anchorIdOverride ?? resumeState.target.anchor_id,
    locations: cloneLocations(resumeState.locations),
    text: cloneTextContext(resumeState.text),
    source,
    allowSectionTopFallback: true,
  };
}

function findSectionByHrefPath(
  sections: ReaderNavigationSection[],
  hrefPath: string,
  anchorId: string | null,
): ReaderNavigationSection | null {
  return (
    sections.find(
      (section) =>
        section.href_path === hrefPath &&
        anchorId !== null &&
        section.anchor_id === anchorId,
    ) ??
    sections.find((section) => section.href_path === hrefPath) ??
    null
  );
}

function resolveSectionIdByTotalProgression(
  sections: ReaderNavigationSection[],
  totalProgression: number,
): string | null {
  const totalCharCount = sections.reduce(
    (sum, section) => sum + (section.char_count ?? 0),
    0,
  );
  if (totalCharCount <= 0) {
    return null;
  }

  const clampedProgression = Math.max(0, Math.min(totalProgression, 1));
  const targetOffset = Math.min(
    totalCharCount - 1,
    Math.floor(clampedProgression * totalCharCount),
  );

  let sectionStart = 0;
  for (const section of sections) {
    const sectionEnd = sectionStart + (section.char_count ?? 0);
    if (targetOffset < sectionEnd) {
      return section.section_id;
    }
    sectionStart = sectionEnd;
  }
  return null;
}

function resolveSectionIdByPosition(
  sections: ReaderNavigationSection[],
  position: number,
  readerPositionBucketCp: number,
): string | null {
  const targetOffset = (position - 1) * readerPositionBucketCp;
  let sectionStart = 0;
  for (const section of sections) {
    const sectionEnd = sectionStart + (section.char_count ?? 0);
    if (targetOffset < sectionEnd) {
      return section.section_id;
    }
    sectionStart = sectionEnd;
  }
  return null;
}

export function resolveInitialEpubRestoreRequest({
  requestedSectionId,
  resumeState,
  sections,
  readerPositionBucketCp,
}: {
  requestedSectionId: string | null;
  resumeState: EpubReaderResumeState | null;
  sections: ReaderNavigationSection[];
  readerPositionBucketCp: number;
}): EpubRestoreRequest | null {
  if (sections.length === 0) {
    return null;
  }

  if (requestedSectionId) {
    const requestedSection = sections.find(
      (section) => section.section_id === requestedSectionId,
    );
    if (requestedSection) {
      return buildResumeRequest(
        requestedSection.section_id,
        "initial_url",
        resumeState,
        requestedSection.anchor_id,
      );
    }
  }

  if (resumeState) {
    const directMatch =
      sections.find(
        (section) => section.section_id === resumeState.target.section_id,
      ) ??
      findSectionByHrefPath(
        sections,
        resumeState.target.href_path,
        resumeState.target.anchor_id,
      );
    if (directMatch) {
      return buildResumeRequest(
        directMatch.section_id,
        "resume_target",
        resumeState,
        resumeState.target.anchor_id,
      );
    }

    if (resumeState.locations.total_progression !== null) {
      const sectionId = resolveSectionIdByTotalProgression(
        sections,
        resumeState.locations.total_progression,
      );
      if (sectionId) {
        return buildResumeRequest(
          sectionId,
          "resume_total_progression",
          resumeState,
          null,
        );
      }
    }

    if (resumeState.locations.position !== null) {
      const sectionId = resolveSectionIdByPosition(
        sections,
        resumeState.locations.position,
        readerPositionBucketCp,
      );
      if (sectionId) {
        return buildResumeRequest(
          sectionId,
          "resume_position",
          resumeState,
          null,
        );
      }
    }
  }

  return buildEmptyRequest(sections[0].section_id, "default", null);
}

export function buildManualSectionRestoreRequest(
  sectionId: string,
  anchorId: string | null = null,
): EpubRestoreRequest {
  return buildEmptyRequest(
    sectionId,
    "manual_section",
    anchorId,
    anchorId === null,
  );
}
