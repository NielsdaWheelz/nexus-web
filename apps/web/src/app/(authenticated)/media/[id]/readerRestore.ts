import type { EpubNavigationSection } from "@/lib/media/epubReader";
import type {
  EpubReaderResumeState,
  ReaderResumeLocations,
  ReaderResumeTextContext,
} from "@/lib/reader";

export type ReaderRestorePhase =
  | "idle"
  | "resolving"
  | "opening_target"
  | "restoring_exact"
  | "restoring_fallback"
  | "settled"
  | "cancelled";

export type EpubRestoreSource =
  | "initial_url"
  | "resume_target"
  | "resume_total_progression"
  | "resume_position"
  | "default"
  | "history"
  | "manual_section"
  | "internal_link";

export interface EpubRestoreRequest {
  sectionId: string;
  anchorId: string | null;
  locations: ReaderResumeLocations;
  text: ReaderResumeTextContext;
  source: EpubRestoreSource;
  allowSectionTopFallback: boolean;
}

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

function buildEmptyEpubRestoreRequest(
  sectionId: string,
  source: EpubRestoreSource,
  anchorId: string | null,
  allowSectionTopFallback = true
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

function cloneLocations(locations: ReaderResumeLocations): ReaderResumeLocations {
  return {
    text_offset: locations.text_offset,
    progression: locations.progression,
    total_progression: locations.total_progression,
    position: locations.position,
  };
}

function cloneTextContext(text: ReaderResumeTextContext): ReaderResumeTextContext {
  return {
    quote: text.quote,
    quote_prefix: text.quote_prefix,
    quote_suffix: text.quote_suffix,
  };
}

function buildEpubResumeRequest(
  sectionId: string,
  source: EpubRestoreSource,
  resumeState: EpubReaderResumeState | null,
  anchorIdOverride: string | null
): EpubRestoreRequest {
  if (!resumeState || resumeState.target.section_id !== sectionId) {
    return buildEmptyEpubRestoreRequest(sectionId, source, anchorIdOverride);
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
  sections: EpubNavigationSection[],
  hrefPath: string,
  anchorId: string | null
): EpubNavigationSection | null {
  return (
    sections.find(
      (section) => section.href_path === hrefPath && anchorId !== null && section.anchor_id === anchorId
    ) ??
    sections.find((section) => section.href_path === hrefPath) ??
    null
  );
}

function resolveSectionIdByTotalProgression(
  sections: EpubNavigationSection[],
  totalProgression: number
): string | null {
  const totalCharCount = sections.reduce((sum, section) => sum + section.char_count, 0);
  if (totalCharCount <= 0) {
    return null;
  }

  const clampedProgression = Math.max(0, Math.min(totalProgression, 1));
  const targetOffset = Math.min(
    totalCharCount - 1,
    Math.floor(clampedProgression * totalCharCount)
  );

  let sectionStart = 0;
  for (const section of sections) {
    const sectionEnd = sectionStart + section.char_count;
    if (targetOffset < sectionEnd) {
      return section.section_id;
    }
    sectionStart = sectionEnd;
  }
  return null;
}

function resolveSectionIdByPosition(
  sections: EpubNavigationSection[],
  position: number,
  readerPositionBucketCp: number
): string | null {
  const targetOffset = (position - 1) * readerPositionBucketCp;
  let sectionStart = 0;
  for (const section of sections) {
    const sectionEnd = sectionStart + section.char_count;
    if (targetOffset < sectionEnd) {
      return section.section_id;
    }
    sectionStart = sectionEnd;
  }
  return null;
}

export function resolveInitialEpubRestoreRequest(options: {
  requestedSectionId: string | null;
  resumeState: EpubReaderResumeState | null;
  sections: EpubNavigationSection[];
  readerPositionBucketCp: number;
}): EpubRestoreRequest | null {
  const { requestedSectionId, resumeState, sections, readerPositionBucketCp } = options;
  if (sections.length === 0) {
    return null;
  }

  if (requestedSectionId) {
    const requestedSection = sections.find((section) => section.section_id === requestedSectionId);
    if (requestedSection) {
      return buildEpubResumeRequest(requestedSection.section_id, "initial_url", resumeState, null);
    }
  }

  if (resumeState) {
    const directMatch =
      sections.find((section) => section.section_id === resumeState.target.section_id) ??
      findSectionByHrefPath(sections, resumeState.target.href_path, resumeState.target.anchor_id);
    if (directMatch) {
      return buildEpubResumeRequest(
        directMatch.section_id,
        "resume_target",
        resumeState,
        resumeState.target.anchor_id
      );
    }

    const totalProgression = resumeState.locations.total_progression;
    if (totalProgression !== null) {
      const sectionId = resolveSectionIdByTotalProgression(sections, totalProgression);
      if (sectionId) {
        return buildEpubResumeRequest(sectionId, "resume_total_progression", resumeState, null);
      }
    }

    const position = resumeState.locations.position;
    if (position !== null) {
      const sectionId = resolveSectionIdByPosition(sections, position, readerPositionBucketCp);
      if (sectionId) {
        return buildEpubResumeRequest(sectionId, "resume_position", resumeState, null);
      }
    }
  }

  return buildEmptyEpubRestoreRequest(sections[0].section_id, "default", null);
}

export function buildHistoryEpubRestoreRequest(
  sectionId: string
): EpubRestoreRequest {
  return buildEmptyEpubRestoreRequest(sectionId, "history", null);
}

export function buildManualSectionRestoreRequest(
  sectionId: string,
  anchorId: string | null = null
): EpubRestoreRequest {
  return buildEmptyEpubRestoreRequest(
    sectionId,
    "manual_section",
    anchorId,
    anchorId === null
  );
}

export function buildInternalLinkRestoreRequest(
  sectionId: string,
  anchorId: string | null
): EpubRestoreRequest {
  return buildEmptyEpubRestoreRequest(
    sectionId,
    "internal_link",
    anchorId,
    anchorId === null
  );
}

export function isUserScrollKey(event: KeyboardEvent): boolean {
  return (
    event.key === "ArrowDown" ||
    event.key === "ArrowUp" ||
    event.key === "PageDown" ||
    event.key === "PageUp" ||
    event.key === "Home" ||
    event.key === "End" ||
    event.key === " " ||
    event.key === "Spacebar"
  );
}
