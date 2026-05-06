/**
 * Route owner for media viewing.
 *
 * Composes route-local media state with the reader leaf components and
 * workspace chrome.
 */

"use client";

import { useEffect, useState, useCallback, useRef, useMemo, type CSSProperties } from "react";
import ReaderAssistantPane, {
  type ReaderAssistantScopeOption,
} from "@/components/chat/ReaderAssistantPane";
import type { ReaderSourceTarget } from "@/components/chat/MessageRow";
import QuoteChatSheet from "@/components/chat/QuoteChatSheet";
import HtmlRenderer from "@/components/HtmlRenderer";
import ReaderGutter, {
  type ReaderGutterTranscriptHighlight,
} from "@/components/reader/ReaderGutter";
import HighlightsInspectorOverlay from "@/components/reader/HighlightsInspectorOverlay";
import ReaderChatOverlay from "@/components/chat/ReaderChatOverlay";
import { dispatchReaderPulse } from "@/lib/reader/pulseEvent";
import PdfReader, {
  type PdfHighlightOut,
  type PdfReaderSelectionQuote,
  type PdfReaderControlActions,
  type PdfReaderControlsState,
  type PdfTemporaryHighlight,
} from "@/components/PdfReader";
import SelectionPopover from "@/components/SelectionPopover";
import { apiFetch, isApiError } from "@/lib/api/client";
import {
  FeedbackNotice,
  toFeedback,
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { mediaResourceOptions } from "@/lib/actions/resourceActions";
import type { ContextItem } from "@/lib/api/sse";
import {
  applyHighlightsToHtml,
  type HighlightInput,
} from "@/lib/highlights/applySegments";
import {
  buildCanonicalCursor,
  canonicalCpToRawCp,
  validateCanonicalText,
  type CanonicalCursorResult,
} from "@/lib/highlights/canonicalCursor";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import {
  codepointToUtf16,
  selectionToOffsets,
} from "@/lib/highlights/selectionToOffsets";
import {
  useHighlightInteraction,
  parseHighlightElement,
  findHighlightElement,
  applyFocusClass,
  reconcileFocusAfterRefetch,
} from "@/lib/highlights/useHighlightInteraction";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import MediaHighlightsPaneBody from "./MediaHighlightsPaneBody";
import Pill from "@/components/ui/Pill";
import ActionMenu, { type ActionMenuOption } from "@/components/ui/ActionMenu";
import LibraryMembershipPanel from "@/components/LibraryMembershipPanel";
import type { LibraryTargetPickerItem } from "@/components/LibraryTargetPicker";
import {
  usePaneParam,
  usePaneRouter,
  usePaneSearchParams,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import {
  usePaneChromeOverride,
  usePaneMobileChromeController,
} from "@/components/workspace/PaneShell";
import { useReaderContext } from "@/lib/reader/ReaderContext";
import {
  isPdfReaderResumeState,
  isReflowableReaderResumeState,
  type EpubReaderResumeState,
  type ReaderResumeLocations,
  type ReaderResumeState,
  type ReaderResumeTextContext,
} from "@/lib/reader/types";
import { useReaderResumeState } from "@/lib/reader/useReaderResumeState";
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import type { ConversationScope } from "@/lib/conversations/types";
import {
  normalizeEpubNavigationToc,
  isReadableStatus,
  type EpubNavigationResponse,
  type EpubNavigationSection,
  type EpubSectionContent,
  type NormalizedNavigationTocNode,
} from "@/lib/media/epubReader";
import EpubContentPane from "./EpubContentPane";
import TranscriptPlaybackPanel from "./TranscriptPlaybackPanel";
import TranscriptContentPanel from "./TranscriptContentPanel";
import TranscriptStatePanel from "./TranscriptStatePanel";
import {
  type Fragment,
  type TranscriptChapter,
  type TranscriptCoverage,
  type TranscriptFragment,
  type TranscriptPlaybackSource,
  type TranscriptState,
  resolveActiveTranscriptFragment,
  normalizeTranscriptChapters,
} from "./transcriptView";
import {
  type Highlight,
  fetchHighlights,
  createHighlight,
  updateHighlight,
  deleteHighlight,
} from "./mediaHighlights";
import { createNoteBlock, deleteNoteBlock, updateNoteBlock } from "@/lib/notes/api";
import ContributorCreditList from "@/components/contributors/ContributorCreditList";
import type { ContributorCredit } from "@/lib/contributors/types";
import { buildCompactMediaPaneTitle, formatResumeTime } from "./mediaFormatting";
import {
  type NavigationTocNodeLike,
  buildEpubLocationHref,
  resolveSectionAnchorId,
} from "./epubHelpers";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import Button from "@/components/ui/Button";
import Select from "@/components/ui/Select";
import styles from "./page.module.css";

// =============================================================================
// Constants
// =============================================================================

interface Media {
  id: string;
  kind: string;
  title: string;
  podcast_title?: string | null;
  podcast_image_url?: string | null;
  canonical_source_url: string | null;
  processing_status: string;
  transcript_state?: TranscriptState;
  transcript_coverage?: TranscriptCoverage;
  retrieval_status?: string | null;
  retrieval_status_reason?: string | null;
  capabilities?: {
    can_read: boolean;
    can_highlight: boolean;
    can_quote: boolean;
    can_search: boolean;
    can_play: boolean;
    can_download_file: boolean;
    can_delete?: boolean;
    can_retry?: boolean;
    can_refresh_source?: boolean;
  };
  playback_source?: TranscriptPlaybackSource | null;
  chapters?: TranscriptChapter[];
  contributors: ContributorCredit[];
  published_date?: string | null;
  publisher?: string | null;
  language?: string | null;
  listening_state?: {
    position_ms: number;
    duration_ms?: number | null;
    playback_speed: number;
    is_completed?: boolean;
  } | null;
  subscription_default_playback_speed?: number | null;
  episode_state?: "unplayed" | "in_progress" | "played" | null;
  failure_stage?: string | null;
  last_error_code?: string | null;
  description?: string | null;
  description_html?: string | null;
  description_text?: string | null;
  created_at: string;
  updated_at: string;
}

interface SelectionState {
  fragmentId: string;
  startOffset: number;
  endOffset: number;
  selectedText: string;
  rect: DOMRect;
  lineRects: DOMRect[];
}

interface ActiveContent {
  fragmentId: string;
  htmlSanitized: string;
  canonicalText: string;
}

interface PdfHighlightsPaneState {
  activePage: number;
  highlights: PdfHighlightOut[];
  version: number;
}

interface EvidenceResolutionResponse {
  data: {
    evidence_span_id: string;
    resolver: {
      kind: "web" | "epub" | "pdf" | "transcript";
      params: Record<string, string>;
      status: string;
      highlight?: Record<string, unknown> | null;
    };
  };
}

const MOBILE_SELECTION_STABILIZATION_DELAY_MS = 180;
const TEXT_ANCHOR_TOP_PADDING_PX = 56;
const READER_POSITION_BUCKET_CP = 1024;
const DOCUMENT_PROCESSING_POLL_INTERVAL_MS = 3000;
const READER_QUOTE_EXACT_CP = 48;
const READER_QUOTE_CONTEXT_CP = 24;
const READER_SELECTION_CONTEXT_CP = 160;

function createEmptyPdfHighlightsPaneState(): PdfHighlightsPaneState {
  return {
    activePage: 1,
    highlights: [],
    version: 0,
  };
}

function escapeAttrValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function getPaneScrollContainer(
  contentNode: HTMLDivElement | null
): HTMLElement | null {
  if (!contentNode) {
    return null;
  }

  const paneContent = contentNode.closest<HTMLElement>('[data-pane-content="true"]');
  if (paneContent) {
    return paneContent;
  }

  if (typeof document !== "undefined" && document.scrollingElement) {
    return document.scrollingElement as HTMLElement;
  }
  return null;
}

function getPaneScrollTopPaddingPx(container: HTMLElement): number {
  if (typeof window === "undefined") {
    return TEXT_ANCHOR_TOP_PADDING_PX;
  }

  const parsed = Number.parseFloat(window.getComputedStyle(container).scrollPaddingTop);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return TEXT_ANCHOR_TOP_PADDING_PX;
}

function buildSelectionSnapshotKey(selection: SelectionState): string {
  const { left, top, width, height } = selection.rect;
  return [
    selection.fragmentId,
    String(selection.startOffset),
    String(selection.endOffset),
    selection.selectedText,
    left.toFixed(1),
    top.toFixed(1),
    width.toFixed(1),
    height.toFixed(1),
  ].join("::");
}

function canonicalCpLength(text: string): number {
  return [...text].length;
}

function findFirstVisibleCanonicalOffset(
  container: HTMLElement,
  cursor: CanonicalCursorResult
): number | null {
  const containerRect = container.getBoundingClientRect();
  const topPaddingPx = getPaneScrollTopPaddingPx(container);
  const probeTop =
    containerRect.top +
    Math.min(
      topPaddingPx,
      Math.max(8, Math.floor(containerRect.height * 0.12))
    );

  for (const entry of cursor.nodes) {
    const anchorElement = entry.node.parentElement;
    if (!anchorElement) {
      continue;
    }
    const rect = anchorElement.getBoundingClientRect();
    if (rect.bottom < probeTop || rect.top > containerRect.bottom) {
      continue;
    }
    if ((entry.node.textContent ?? "").trim().length === 0) {
      continue;
    }
    return entry.start;
  }
  return null;
}

function scrollToCanonicalTextAnchor(
  container: HTMLElement,
  cursor: CanonicalCursorResult,
  canonicalOffset: number
): boolean {
  if (cursor.nodes.length === 0) {
    return false;
  }

  const clampedOffset = Math.max(0, Math.min(canonicalOffset, cursor.length));
  const targetNode =
    cursor.nodes.find((entry) => clampedOffset >= entry.start && clampedOffset < entry.end) ??
    cursor.nodes.find((entry) => entry.start >= clampedOffset) ??
    cursor.nodes[cursor.nodes.length - 1];

  if (!targetNode) {
    return false;
  }

  const rawText = targetNode.node.textContent ?? "";
  const nodeCanonicalLength = Math.max(0, targetNode.end - targetNode.start);
  const localCanonicalOffset = Math.max(
    0,
    Math.min(clampedOffset - targetNode.start, nodeCanonicalLength)
  );
  const localRawCpOffset = canonicalCpToRawCp(
    rawText,
    localCanonicalOffset,
    targetNode.trimLeadCp
  );
  const localRawUtf16Offset = Math.max(
    0,
    Math.min(codepointToUtf16(rawText, localRawCpOffset), rawText.length)
  );

  const range = document.createRange();
  range.setStart(targetNode.node, localRawUtf16Offset);
  range.collapse(true);

  const containerRect = container.getBoundingClientRect();
  const topPaddingPx = getPaneScrollTopPaddingPx(container);
  const targetRect = range.getBoundingClientRect();
  if (targetRect.width > 0 || targetRect.height > 0) {
    const delta = targetRect.top - containerRect.top - topPaddingPx;
    container.scrollTop = Math.max(0, container.scrollTop + delta);
    return true;
  }

  const fallbackElement = targetNode.node.parentElement;
  if (fallbackElement) {
    fallbackElement.scrollIntoView({ block: "start", behavior: "auto" });
    return true;
  }
  return false;
}

function buildCanonicalQuoteWindow(
  canonicalText: string,
  canonicalOffset: number
): {
  quote: string | null;
  quotePrefix: string | null;
  quoteSuffix: string | null;
} {
  const chars = [...canonicalText];
  if (chars.length === 0) {
    return { quote: null, quotePrefix: null, quoteSuffix: null };
  }

  const clampedOffset = Math.max(0, Math.min(Math.floor(canonicalOffset), chars.length - 1));
  const quoteStart = Math.min(
    clampedOffset,
    Math.max(0, chars.length - READER_QUOTE_EXACT_CP)
  );
  const quoteEnd = Math.min(chars.length, quoteStart + READER_QUOTE_EXACT_CP);
  const prefixStart = Math.max(0, quoteStart - READER_QUOTE_CONTEXT_CP);
  const suffixEnd = Math.min(chars.length, quoteEnd + READER_QUOTE_CONTEXT_CP);

  const quote = chars.slice(quoteStart, quoteEnd).join("");
  const quotePrefix = chars.slice(prefixStart, quoteStart).join("");
  const quoteSuffix = chars.slice(quoteEnd, suffixEnd).join("");

  return {
    quote: quote.length > 0 ? quote : null,
    quotePrefix: quotePrefix.length > 0 ? quotePrefix : null,
    quoteSuffix: quoteSuffix.length > 0 ? quoteSuffix : null,
  };
}

function findCanonicalOffsetFromQuote(
  canonicalText: string,
  quote: string | null,
  quotePrefix: string | null,
  quoteSuffix: string | null
): number | null {
  if (!quote) {
    return null;
  }

  const chars = [...canonicalText];
  const quoteChars = [...quote];
  const prefixChars = quotePrefix ? [...quotePrefix] : [];
  const suffixChars = quoteSuffix ? [...quoteSuffix] : [];
  if (quoteChars.length === 0 || chars.length < quoteChars.length) {
    return null;
  }

  let bestOffset: number | null = null;
  let bestScore = -1;

  for (let start = 0; start <= chars.length - quoteChars.length; start += 1) {
    let matchesQuote = true;
    for (let idx = 0; idx < quoteChars.length; idx += 1) {
      if (chars[start + idx] !== quoteChars[idx]) {
        matchesQuote = false;
        break;
      }
    }
    if (!matchesQuote) {
      continue;
    }

    let score = 0;
    if (prefixChars.length > 0 && start >= prefixChars.length) {
      let matchesPrefix = true;
      for (let idx = 0; idx < prefixChars.length; idx += 1) {
        if (chars[start - prefixChars.length + idx] !== prefixChars[idx]) {
          matchesPrefix = false;
          break;
        }
      }
      if (matchesPrefix) {
        score += 2;
      }
    }
    if (suffixChars.length > 0 && start + quoteChars.length + suffixChars.length <= chars.length) {
      let matchesSuffix = true;
      for (let idx = 0; idx < suffixChars.length; idx += 1) {
        if (chars[start + quoteChars.length + idx] !== suffixChars[idx]) {
          matchesSuffix = false;
          break;
        }
      }
      if (matchesSuffix) {
        score += 1;
      }
    }

    if (bestOffset === null || score > bestScore) {
      bestOffset = start;
      bestScore = score;
      if (score === 3) {
        break;
      }
    }
  }

  return bestOffset;
}

function parsePositivePageNumber(raw: string | null | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

function parseNonnegativeMs(raw: string | null | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function textQuoteField(highlight: Record<string, unknown>, key: string): string | null {
  const textQuote = highlight.text_quote;
  if (typeof textQuote !== "object" || textQuote === null || Array.isArray(textQuote)) {
    return null;
  }
  const value = (textQuote as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isCanonicalTextAnchorVisible(
  container: HTMLElement,
  cursor: CanonicalCursorResult,
  canonicalOffset: number
): boolean {
  if (cursor.nodes.length === 0) {
    return false;
  }

  const clampedOffset = Math.max(0, Math.min(canonicalOffset, cursor.length));
  const targetNode =
    cursor.nodes.find((entry) => clampedOffset >= entry.start && clampedOffset < entry.end) ??
    cursor.nodes.find((entry) => entry.start >= clampedOffset) ??
    cursor.nodes[cursor.nodes.length - 1];

  if (!targetNode) {
    return false;
  }

  const rawText = targetNode.node.textContent ?? "";
  const nodeCanonicalLength = Math.max(0, targetNode.end - targetNode.start);
  const localCanonicalOffset = Math.max(
    0,
    Math.min(clampedOffset - targetNode.start, nodeCanonicalLength)
  );
  const localRawCpOffset = canonicalCpToRawCp(
    rawText,
    localCanonicalOffset,
    targetNode.trimLeadCp
  );
  const localRawUtf16Offset = Math.max(
    0,
    Math.min(codepointToUtf16(rawText, localRawCpOffset), rawText.length)
  );

  const range = document.createRange();
  range.setStart(targetNode.node, localRawUtf16Offset);
  range.collapse(true);

  const containerRect = container.getBoundingClientRect();
  const visibleTop =
    containerRect.top + Math.floor(getPaneScrollTopPaddingPx(container) / 2);
  const targetRect = range.getBoundingClientRect();
  if (targetRect.width > 0 || targetRect.height > 0) {
    return targetRect.bottom > visibleTop && targetRect.top < containerRect.bottom;
  }

  const fallbackElement = targetNode.node.parentElement;
  if (!fallbackElement) {
    return false;
  }
  const fallbackRect = fallbackElement.getBoundingClientRect();
  return fallbackRect.bottom > visibleTop && fallbackRect.top < containerRect.bottom;
}

function useIntervalPoll({
  enabled,
  onPoll,
  pollIntervalMs,
}: {
  enabled: boolean;
  onPoll: () => Promise<void> | void;
  pollIntervalMs: number;
}): void {
  useEffect(() => {
    if (!enabled || pollIntervalMs <= 0) {
      return;
    }

    let cancelled = false;
    let inFlight = false;
    const runPoll = () => {
      if (cancelled || inFlight) {
        return;
      }
      inFlight = true;
      void Promise.resolve(onPoll())
        .catch(() => {
          console.error("media_route_poll_failed");
        })
        .finally(() => {
          inFlight = false;
        });
    };

    const timer = setInterval(runPoll, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, onPoll, pollIntervalMs]);
}

function shouldPollDocumentProcessing(
  mediaKind: string | null | undefined,
  processingStatus: string | null | undefined
): boolean {
  if (mediaKind !== "epub" && mediaKind !== "pdf" && mediaKind !== "web_article") {
    return false;
  }
  return (
    processingStatus === "pending" ||
    processingStatus === "extracting" ||
    processingStatus === "embedding"
  );
}

type ReaderRestorePhase =
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
  | "history"
  | "manual_section"
  | "internal_link";

type EpubRestoreRequest = {
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
      (section) =>
        section.href_path === hrefPath &&
        anchorId !== null &&
        section.anchor_id === anchorId
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
  const targetOffset = Math.min(totalCharCount - 1, Math.floor(clampedProgression * totalCharCount));

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

function resolveInitialEpubRestoreRequest({
  requestedSectionId,
  resumeState,
  sections,
  readerPositionBucketCp,
}: {
  requestedSectionId: string | null;
  resumeState: EpubReaderResumeState | null;
  sections: EpubNavigationSection[];
  readerPositionBucketCp: number;
}): EpubRestoreRequest | null {
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

    if (resumeState.locations.total_progression !== null) {
      const sectionId = resolveSectionIdByTotalProgression(
        sections,
        resumeState.locations.total_progression
      );
      if (sectionId) {
        return buildEpubResumeRequest(sectionId, "resume_total_progression", resumeState, null);
      }
    }

    if (resumeState.locations.position !== null) {
      const sectionId = resolveSectionIdByPosition(
        sections,
        resumeState.locations.position,
        readerPositionBucketCp
      );
      if (sectionId) {
        return buildEpubResumeRequest(sectionId, "resume_position", resumeState, null);
      }
    }
  }

  return buildEmptyEpubRestoreRequest(sections[0].section_id, "default", null);
}

function buildManualSectionRestoreRequest(
  sectionId: string,
  anchorId: string | null = null
): EpubRestoreRequest {
  return buildEmptyEpubRestoreRequest(sectionId, "manual_section", anchorId, anchorId === null);
}

function isUserScrollKey(event: KeyboardEvent): boolean {
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

export default function MediaPaneBody() {
  const id = usePaneParam("id");
  if (!id) {
    throw new Error("media route requires an id");
  }

  const router = usePaneRouter();
  const searchParams = usePaneSearchParams();
  const paneMobileChrome = usePaneMobileChromeController();
  const requestedFragmentId = searchParams.get("fragment");
  const requestedHighlightId = searchParams.get("highlight");
  const requestedEvidenceId = searchParams.get("evidence");
  const requestedEpubLoc = searchParams.get("loc");
  const requestedPdfPageNumber = parsePositivePageNumber(searchParams.get("page"));
  const requestedStartMs = parseNonnegativeMs(searchParams.get("t_start_ms"));
  const feedback = useFeedback();
  const isMobileViewport = useIsMobileViewport();
  const {
    profile: readerProfile,
    loading: readerProfileLoading,
    save: saveReaderProfile,
    updateTheme,
  } = useReaderContext();
  const {
    state: readerResumeState,
    loading: liveReaderResumeStateLoading,
    save: saveReaderResumeState,
  } = useReaderResumeState({
    mediaId: id,
    debounceMs: 500,
  });
  const [initialReaderResumeState, setInitialReaderResumeState] = useState<
    ReaderResumeState | null | undefined
  >(undefined);
  const initialReaderResumeStateLoading = initialReaderResumeState === undefined;
  const initialPdfResumeState = isPdfReaderResumeState(initialReaderResumeState)
    ? initialReaderResumeState
    : null;
  const initialTextResumeState = isReflowableReaderResumeState(initialReaderResumeState)
    ? initialReaderResumeState
    : null;
  const initialEpubResumeState =
    initialReaderResumeState?.kind === "epub"
      ? (initialReaderResumeState as EpubReaderResumeState)
      : null;
  const readerResumeSource =
    initialTextResumeState?.kind === "epub"
      ? initialTextResumeState.target.href_path
      : initialTextResumeState?.target.fragment_id ?? null;
  const readerResumeTextOffset = initialTextResumeState?.locations.text_offset ?? null;
  const readerResumeQuote = initialTextResumeState?.text.quote ?? null;
  const readerResumeQuotePrefix = initialTextResumeState?.text.quote_prefix ?? null;
  const readerResumeQuoteSuffix = initialTextResumeState?.text.quote_suffix ?? null;
  const readerResumeProgression = initialTextResumeState?.locations.progression ?? null;
  const readerResumeTotalProgression =
    initialTextResumeState?.locations.total_progression ?? null;
  const readerResumePosition = initialTextResumeState?.locations.position ?? null;
  const scrollRestoreAppliedRef = useRef(false);
  const lastSavedTextAnchorOffsetRef = useRef<number | null>(null);
  const [textRestoreSettled, setTextRestoreSettled] = useState(false);
  const [readerLayoutReady, setReaderLayoutReady] = useState(false);

  useEffect(() => {
    setInitialReaderResumeState(undefined);
  }, [id]);

  useEffect(() => {
    if (liveReaderResumeStateLoading || initialReaderResumeState !== undefined) {
      return;
    }
    setInitialReaderResumeState(readerResumeState);
  }, [initialReaderResumeState, liveReaderResumeStateLoading, readerResumeState]);

  // ---- Core data state ----
  const [media, setMedia] = useState<Media | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FeedbackContent | null>(null);
  useSetPaneTitle(buildCompactMediaPaneTitle(media));

  // ---- Non-EPUB fragment state ----
  const [fragments, setFragments] = useState<Fragment[]>([]);
  const [activeTranscriptFragmentId, setActiveTranscriptFragmentId] = useState<string | null>(
    null
  );

  // ---- EPUB state ----
  const [epubSections, setEpubSections] = useState<EpubNavigationSection[] | null>(null);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [epubRestoreRequest, setEpubRestoreRequest] = useState<EpubRestoreRequest | null>(null);
  const [restorePhase, setRestorePhase] = useState<ReaderRestorePhase>("idle");
  const [activeEpubSection, setActiveEpubSection] = useState<EpubSectionContent | null>(null);
  const [epubToc, setEpubToc] = useState<NormalizedNavigationTocNode[] | null>(null);
  const [tocWarning, setTocWarning] = useState(false);
  const [epubSectionLoading, setEpubSectionLoading] = useState(false);
  const [epubError, setEpubError] = useState<string | null>(null);
  const [epubTocExpanded, setEpubTocExpanded] = useState(false);
  const [pdfControlsState, setPdfControlsState] = useState<PdfReaderControlsState | null>(null);
  const pdfControlsRef = useRef<PdfReaderControlActions | null>(null);
  const restoreSessionIdRef = useRef(0);
  const initialEpubRestoreResolvedRef = useRef(false);

  // Request-version guard for stale EPUB/highlight responses
  const epubSectionVersionRef = useRef(0);
  const highlightVersionRef = useRef(0);

  // ---- Highlight interaction state ----
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [pdfHighlightsPaneState, setPdfHighlightsPaneState] = useState<PdfHighlightsPaneState>(
    createEmptyPdfHighlightsPaneState
  );
  // Accumulated PDF highlights across every page seen so the right-edge
  // gutter can heatmap the whole document (Phase 1B P5). The reader streams
  // page highlights into us via `onPageHighlightsChange`; we union them here.
  const [pdfDocumentHighlights, setPdfDocumentHighlights] = useState<
    PdfHighlightOut[]
  >([]);
  const [resolvedEvidence, setResolvedEvidence] = useState<
    EvidenceResolutionResponse["data"] | null
  >(null);
  const [readerSourceTarget, setReaderSourceTarget] = useState<ReaderSourceTarget | null>(null);
  const [pdfRefreshToken, setPdfRefreshToken] = useState(0);

  useEffect(() => {
    if (!requestedEvidenceId) {
      setResolvedEvidence(null);
      return;
    }

    let cancelled = false;
    void apiFetch<EvidenceResolutionResponse>(
      `/api/media/${id}/evidence/${requestedEvidenceId}`
    )
      .then((response) => {
        if (!cancelled) {
          setResolvedEvidence(response.data);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setResolvedEvidence(null);
        if (!isApiError(error) || error.status !== 404) {
          feedback.show({ severity: "error", title: "Failed to resolve citation" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [feedback, id, requestedEvidenceId]);

  const resolvedEvidenceParams = resolvedEvidence?.resolver.params ?? null;
  const resolvedEvidenceHighlight = resolvedEvidence?.resolver.highlight ?? null;
  const resolvedEvidenceFragmentId =
    typeof resolvedEvidenceParams?.fragment === "string"
      ? resolvedEvidenceParams.fragment
      : null;
  const resolvedEvidenceEpubLoc =
    typeof resolvedEvidenceParams?.loc === "string" ? resolvedEvidenceParams.loc : null;
  const resolvedEvidenceStartMs =
    parseNonnegativeMs(resolvedEvidenceParams?.t_start_ms) ??
    (resolvedEvidenceHighlight?.kind === "transcript_time_text" &&
    typeof resolvedEvidenceHighlight.t_start_ms === "number" &&
    Number.isInteger(resolvedEvidenceHighlight.t_start_ms) &&
    resolvedEvidenceHighlight.t_start_ms >= 0
      ? resolvedEvidenceHighlight.t_start_ms
      : null);
  const activeRequestedFragmentId = requestedFragmentId ?? resolvedEvidenceFragmentId;
  const activeRequestedEpubLoc = requestedEpubLoc ?? resolvedEvidenceEpubLoc;
  const activeRequestedStartMs = requestedStartMs ?? resolvedEvidenceStartMs;
  const activeRequestedPdfPageNumber =
    requestedPdfPageNumber ?? parsePositivePageNumber(resolvedEvidenceParams?.page);

  const {
    focusState,
    focusHighlight,
    handleHighlightClick,
    clearFocus,
    startEditBounds,
    cancelEditBounds,
  } = useHighlightInteraction();
  const focusedHighlightIdRef = useRef<string | null>(focusState.focusedId);
  const urlHighlightAppliedRef = useRef<string | null>(null);
  const urlEvidenceAppliedRef = useRef<string | null>(null);
  const mismatchToastFragmentRef = useRef<string | null>(null);
  const mismatchLoggedFragmentRef = useRef<string | null>(null);

  // Retained canonical selection for highlight actions
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isMismatchDisabled, setIsMismatchDisabled] = useState(false);
  const [readerAssistantState, setReaderAssistantState] = useState<{
    contexts: ContextItem[];
    conversationId: string | null;
    conversationScope: ConversationScope;
    targetLabel?: string;
  } | null>(null);
  const selectionSnapshotRef = useRef<SelectionState | null>(null);
  const selectionSnapshotKeyRef = useRef<string | null>(null);
  const selectionVisibleRef = useRef(false);
  const mobileSelectionTimerRef = useRef<number | null>(null);

  const contentRef = useRef<HTMLDivElement>(null);
  const pdfContentRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<CanonicalCursorResult | null>(null);

  const beginRestoreSession = useCallback(
    (phase: Exclude<ReaderRestorePhase, "settled" | "cancelled">) => {
      restoreSessionIdRef.current += 1;
      scrollRestoreAppliedRef.current = false;
      lastSavedTextAnchorOffsetRef.current = null;
      setTextRestoreSettled(false);
      setRestorePhase(phase);
      return restoreSessionIdRef.current;
    },
    []
  );

  const updateRestorePhase = useCallback(
    (sessionId: number, phase: ReaderRestorePhase) => {
      if (sessionId !== restoreSessionIdRef.current) {
        return false;
      }
      setRestorePhase(phase);
      return true;
    },
    []
  );

  const settleRestoreSession = useCallback(
    (sessionId: number) => {
      if (sessionId !== restoreSessionIdRef.current) {
        return false;
      }
      setRestorePhase("settled");
      setTextRestoreSettled(true);
      setEpubRestoreRequest(null);
      return true;
    },
    []
  );

  const cancelRestoreSession = useCallback(() => {
    restoreSessionIdRef.current += 1;
    setRestorePhase("cancelled");
    setTextRestoreSettled(true);
    setEpubRestoreRequest(null);
  }, []);

  const clearPendingMobileSelectionPublish = useCallback(() => {
    if (mobileSelectionTimerRef.current == null) {
      return;
    }
    window.clearTimeout(mobileSelectionTimerRef.current);
    mobileSelectionTimerRef.current = null;
  }, []);

  const publishSelection = useCallback((nextSelection: SelectionState | null) => {
    selectionVisibleRef.current = nextSelection !== null;
    setSelection(nextSelection);
  }, []);

  const clearRetainedSelection = useCallback(
    (removeLiveSelection: boolean) => {
      clearPendingMobileSelectionPublish();
      selectionSnapshotRef.current = null;
      selectionSnapshotKeyRef.current = null;
      publishSelection(null);
      if (removeLiveSelection) {
        window.getSelection()?.removeAllRanges();
      }
    },
    [clearPendingMobileSelectionPublish, publishSelection]
  );

  useEffect(() => {
    selectionVisibleRef.current = selection !== null;
  }, [selection]);

  useEffect(() => {
    return () => {
      clearPendingMobileSelectionPublish();
    };
  }, [clearPendingMobileSelectionPublish]);

  // ---- Derived state ----
  const isEpub = media?.kind === "epub";
  const isPdf = media?.kind === "pdf";
  const isTranscriptMedia =
    media?.kind === "podcast_episode" || media?.kind === "video";
  const transcriptState = media?.transcript_state ?? null;
  const transcriptCoverage = media?.transcript_coverage ?? null;
  const canRead = media
    ? isTranscriptMedia
      ? Boolean(media.capabilities?.can_read)
      : isReadableStatus(media.processing_status)
    : false;
  const readerLayoutKey = `${readerProfile.font_family}:${readerProfile.font_size_px}:${readerProfile.line_height}:${readerProfile.column_width_ch}`;
  const focusModeEnabled = readerProfile.focus_mode !== "off";
  const showHighlightsPane = canRead && !focusModeEnabled;
  const playbackSource = media?.playback_source ?? null;
  const activeTranscriptFragment = useMemo(() => {
    if (!isTranscriptMedia) {
      return null;
    }

    return resolveActiveTranscriptFragment(fragments, {
      activeFragmentId: activeTranscriptFragmentId,
      requestedFragmentId: activeRequestedFragmentId,
      requestedStartMs: activeRequestedStartMs,
      readerResumeFragmentId: readerResumeSource,
      waitForInitialResumeState: initialReaderResumeStateLoading,
    });
  }, [
    activeTranscriptFragmentId,
    activeRequestedFragmentId,
    activeRequestedStartMs,
    fragments,
    initialReaderResumeStateLoading,
    isTranscriptMedia,
    readerResumeSource,
  ]);

  useEffect(() => {
    if (!isTranscriptMedia || !activeTranscriptFragment) {
      return;
    }

    if (activeTranscriptFragmentId !== activeTranscriptFragment.id) {
      setActiveTranscriptFragmentId(activeTranscriptFragment.id);
    }
  }, [
    activeTranscriptFragmentId,
    activeTranscriptFragment,
    isTranscriptMedia,
  ]);

  useEffect(() => {
    focusedHighlightIdRef.current = focusState.focusedId;
  }, [focusState.focusedId]);

  const applyEpubNavigationResponse = useCallback(
    (navResp: EpubNavigationResponse): EpubNavigationSection[] => {
      const tocNodes = navResp.data.toc_nodes as unknown as NavigationTocNodeLike[];
      const sections = navResp.data.sections.map((section) => ({
        ...section,
        anchor_id: resolveSectionAnchorId(section.section_id, section.anchor_id, tocNodes),
      }));
      const sectionIdSet = new Set(sections.map((section) => section.section_id));
      setEpubSections(sections);
      setEpubToc(normalizeEpubNavigationToc(navResp.data.toc_nodes, sectionIdSet));
      setTocWarning(false);
      return sections;
    },
    []
  );

  const loadEpubNavigation = useCallback(async (): Promise<EpubNavigationSection[]> => {
    const navResp = await apiFetch<EpubNavigationResponse>(`/api/media/${id}/navigation`);
    return applyEpubNavigationResponse(navResp);
  }, [applyEpubNavigationResponse, id]);

  // Active content
  const activeContent: ActiveContent | null = useMemo(() => {
    if (isPdf) {
      return null;
    }
    if (isEpub && activeEpubSection) {
      return {
        fragmentId: activeEpubSection.fragment_id,
        htmlSanitized: activeEpubSection.html_sanitized,
        canonicalText: activeEpubSection.canonical_text,
      };
    }
    const frag = isTranscriptMedia
      ? activeTranscriptFragment
      : fragments.find((fragment) => fragment.id === activeRequestedFragmentId) ??
        fragments[0] ??
        null;
    if (frag) {
      return {
        fragmentId: frag.id,
        htmlSanitized: frag.html_sanitized,
        canonicalText: frag.canonical_text,
      };
    }
    return null;
  }, [
    isPdf,
    isEpub,
    isTranscriptMedia,
    activeRequestedFragmentId,
    activeEpubSection,
    activeTranscriptFragment,
    fragments,
  ]);

  const activeTextSource = useMemo(() => {
    if (isPdf) {
      return null;
    }
    if (isEpub) {
      return activeEpubSection?.href_path ?? null;
    }
    return activeContent?.fragmentId ?? null;
  }, [activeContent?.fragmentId, activeEpubSection?.href_path, isEpub, isPdf]);

  const activeTextAnchor = useMemo(() => {
    if (isPdf) {
      return null;
    }
    if (isEpub) {
      return activeEpubSection?.anchor_id ?? null;
    }
    return null;
  }, [
    activeEpubSection?.anchor_id,
    isEpub,
    isPdf,
  ]);

  const activeTextStartOffset = useMemo(() => {
    if (isPdf) {
      return 0;
    }
    if (isEpub) {
      if (!activeEpubSection || !epubSections) {
        return 0;
      }
      let offset = 0;
      for (const section of epubSections) {
        if (section.section_id === activeEpubSection.section_id) {
          break;
        }
        offset += section.char_count;
      }
      return offset;
    }
    if (!activeContent) {
      return 0;
    }

    let offset = 0;
    for (const fragment of fragments) {
      if (fragment.id === activeContent.fragmentId) {
        break;
      }
      offset += canonicalCpLength(fragment.canonical_text);
    }
    return offset;
  }, [activeContent, activeEpubSection, epubSections, fragments, isEpub, isPdf]);

  const totalTextLength = useMemo(() => {
    if (isPdf) {
      return 0;
    }
    if (isEpub) {
      if (!epubSections || epubSections.length === 0) {
        return activeEpubSection ? canonicalCpLength(activeEpubSection.canonical_text) : 0;
      }
      return epubSections.reduce((sum, section) => sum + section.char_count, 0);
    }
    if (fragments.length > 0) {
      return fragments.reduce(
        (sum, fragment) => sum + canonicalCpLength(fragment.canonical_text),
        0
      );
    }
    return activeContent ? canonicalCpLength(activeContent.canonicalText) : 0;
  }, [activeContent, activeEpubSection, epubSections, fragments, isEpub, isPdf]);

  useEffect(() => {
    const retainedSelection = selectionSnapshotRef.current;
    if (!retainedSelection) {
      return;
    }
    if (!activeContent || retainedSelection.fragmentId !== activeContent.fragmentId || isMismatchDisabled) {
      clearRetainedSelection(false);
    }
  }, [activeContent, clearRetainedSelection, isMismatchDisabled]);

  useEffect(() => {
    // Reset PDF-specific pane state whenever media identity/type changes.
    // This prevents stale cross-document rows from flashing during navigation.
    setPdfHighlightsPaneState(createEmptyPdfHighlightsPaneState());
    setPdfDocumentHighlights([]);
    setPdfRefreshToken(0);
    setReaderSourceTarget(null);
  }, [isPdf, id]);

  // ==========================================================================
  // Data Fetching — initial load
  // ==========================================================================

  useEffect(() => {
    let cancelled = false;

    const fetchData = async () => {
      try {
        const mediaResp = await apiFetch<{ data: Media }>(`/api/media/${id}`);
        if (cancelled) return;
        const m = mediaResp.data;
        setMedia(m);

        const shouldLoadFragments =
          m.kind !== "epub" &&
          m.kind !== "pdf" &&
          (m.kind !== "podcast_episode" && m.kind !== "video"
            ? true
            : Boolean(m.capabilities?.can_read));

        if (shouldLoadFragments) {
          const fragmentsResp = await apiFetch<{ data: Fragment[] }>(
            `/api/media/${id}/fragments`
          );
          if (cancelled) return;
          setFragments(fragmentsResp.data);
        } else {
          setFragments([]);
        }
        setActiveTranscriptFragmentId(null);

        setError(null);
      } catch (err) {
        if (cancelled) return;
        if (isApiError(err)) {
          if (err.status === 404) {
            setError({
              severity: "error",
              title: "Media not found or you don't have access to it.",
            });
          } else {
            setError(toFeedback(err, { fallback: "Failed to load media" }));
          }
        } else {
          setError({ severity: "error", title: "Failed to load media" });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchData();
    return () => { cancelled = true; };
  }, [id]);

  const handleTranscriptStateChange = useCallback(
    ({
      transcriptState: nextTranscriptState,
      transcriptCoverage: nextTranscriptCoverage,
      capabilities,
      lastErrorCode,
      fragments: nextFragments,
    }: {
      transcriptState: TranscriptState;
      transcriptCoverage: TranscriptCoverage;
      capabilities: Media["capabilities"] | null;
      lastErrorCode: string | null;
      fragments: Fragment[] | null;
    }) => {
      setMedia((prev) =>
        prev && prev.id === id
          ? {
              ...prev,
              transcript_state: nextTranscriptState,
              transcript_coverage: nextTranscriptCoverage,
              last_error_code: lastErrorCode,
              capabilities: capabilities ?? prev.capabilities,
            }
          : prev
      );

      if (!nextFragments) {
        return;
      }

      setFragments(nextFragments);
      setActiveTranscriptFragmentId((prev) =>
        nextFragments.some((fragment) => fragment.id === prev) ? prev : null
      );
    },
    [id]
  );

  const refreshDocumentProcessingState = useCallback(async () => {
    if (
      !media?.id ||
      (media.kind !== "epub" && media.kind !== "pdf" && media.kind !== "web_article")
    ) {
      return;
    }

    const mediaResp = await apiFetch<{ data: Media }>(`/api/media/${media.id}`);
    const nextMedia = mediaResp.data;
    setMedia(nextMedia);
    if (
      nextMedia.kind === "web_article" &&
      nextMedia.capabilities?.can_read &&
      fragments.length === 0
    ) {
      const fragmentsResp = await apiFetch<{ data: Fragment[] }>(
        `/api/media/${nextMedia.id}/fragments`
      );
      setFragments(fragmentsResp.data);
    }
  }, [fragments.length, media?.id, media?.kind]);

  const pollDocumentProcessing = useCallback(async () => {
    try {
      await refreshDocumentProcessingState();
    } catch {
      // Keep the pane responsive even if one poll attempt fails.
    }
  }, [refreshDocumentProcessingState]);

  const documentProcessingPollEnabled = shouldPollDocumentProcessing(
    media?.kind,
    media?.processing_status
  );

  useIntervalPoll({
    enabled: Boolean(media?.id) && documentProcessingPollEnabled,
    onPoll: pollDocumentProcessing,
    pollIntervalMs: DOCUMENT_PROCESSING_POLL_INTERVAL_MS,
  });

  // ==========================================================================
  // EPUB orchestration — navigation + initial section
  // ==========================================================================

  useEffect(() => {
    if (!media || media.kind !== "epub" || !isReadableStatus(media.processing_status)) return;
    if (initialReaderResumeStateLoading) return;
    if (initialEpubRestoreResolvedRef.current) return;

    let cancelled = false;
    setEpubError(null);
    const sessionId = beginRestoreSession("resolving");
    initialEpubRestoreResolvedRef.current = true;

    const loadEpub = async () => {
      try {
        const sections = await loadEpubNavigation();
        if (cancelled || sessionId !== restoreSessionIdRef.current) return;

        const restoreRequest = resolveInitialEpubRestoreRequest({
          requestedSectionId: activeRequestedEpubLoc,
          resumeState: initialEpubResumeState,
          sections,
          readerPositionBucketCp: READER_POSITION_BUCKET_CP,
        });

        if (restoreRequest === null) {
          setEpubError("No sections available for this EPUB.");
          void settleRestoreSession(sessionId);
          return;
        }

        const resolvedSection = sections.find(
          (section) => section.section_id === restoreRequest.sectionId
        );
        if (!resolvedSection) {
          setEpubError("No sections available for this EPUB.");
          void settleRestoreSession(sessionId);
          return;
        }

        if (activeRequestedEpubLoc !== restoreRequest.sectionId) {
          router.replace(
            buildEpubLocationHref(id, restoreRequest.sectionId, {
              fragmentId: activeRequestedFragmentId,
              highlightId: requestedHighlightId,
            })
          );
        }

        if (!updateRestorePhase(sessionId, "opening_target")) {
          return;
        }

        setActiveSectionId(restoreRequest.sectionId);
        setEpubRestoreRequest(restoreRequest);
      } catch (err) {
        if (cancelled || sessionId !== restoreSessionIdRef.current) return;
        initialEpubRestoreResolvedRef.current = false;
        if (isApiError(err)) {
          if (err.code === "E_MEDIA_NOT_READY") {
            setEpubError("processing");
          } else if (err.code === "E_MEDIA_NOT_FOUND") {
            setError({
              severity: "error",
              title: "Media not found or you don't have access to it.",
            });
          } else {
            setEpubError(toFeedback(err, { fallback: "Failed to load EPUB navigation." }).title);
          }
        } else {
          setEpubError("Failed to load EPUB navigation.");
        }
      }
    };

    loadEpub();
    return () => {
      cancelled = true;
    };
  }, [
    beginRestoreSession,
    activeRequestedEpubLoc,
    activeRequestedFragmentId,
    id,
    initialEpubResumeState,
    initialReaderResumeStateLoading,
    loadEpubNavigation,
    media,
    requestedHighlightId,
    router,
    settleRestoreSession,
    updateRestorePhase,
  ]);

  // ==========================================================================
  // EPUB — fetch active section content on section change
  // ==========================================================================

  const handleEpubSectionFetchError = useCallback(
    (err: unknown) => {
      if (!isApiError(err)) {
        setEpubError("Failed to load EPUB section.");
        return;
      }

      if (err.code === "E_CHAPTER_NOT_FOUND") {
        setEpubError("EPUB section not found.");
        return;
      }

      if (err.code === "E_MEDIA_NOT_READY") {
        setEpubError("processing");
        return;
      }

      if (err.code === "E_MEDIA_NOT_FOUND") {
        setError({
          severity: "error",
          title: "Media not found or you don't have access to it.",
        });
        return;
      }

      setEpubError(toFeedback(err, { fallback: "Failed to load EPUB section." }).title);
    },
    []
  );

  useEffect(() => {
    if (!isEpub || !activeSectionId) return;

    const version = ++epubSectionVersionRef.current;
    const controller = new AbortController();

    setEpubSectionLoading(true);
    setActiveEpubSection(null);
    clearFocus();
    setHighlights([]);
    clearRetainedSelection(false);

    const load = async () => {
      try {
        const sectionResp = await apiFetch<{ data: EpubSectionContent }>(
          `/api/media/${id}/sections/${encodeURIComponent(activeSectionId)}`,
          { signal: controller.signal }
        );
        if (version !== epubSectionVersionRef.current) return;
        setActiveEpubSection(sectionResp.data);
        setEpubError(null);
      } catch (err) {
        if (controller.signal.aborted || version !== epubSectionVersionRef.current) return;
        handleEpubSectionFetchError(err);
      } finally {
        if (version === epubSectionVersionRef.current) {
          setEpubSectionLoading(false);
        }
      }
    };

    load();
    return () => {
      controller.abort();
    };
  }, [
    activeSectionId,
    clearFocus,
    clearRetainedSelection,
    handleEpubSectionFetchError,
    id,
    isEpub,
  ]);

  // EPUB URL/state sync for browser back/forward on ?loc=
  useEffect(() => {
    if (!isEpub || !epubSections || epubSections.length === 0) return;
    const locParam = activeRequestedEpubLoc;
    if (!locParam || locParam === activeSectionId) return;
    const section = epubSections.find((item) => item.section_id === locParam);
    if (!section) return;
    beginRestoreSession("opening_target");
    setActiveSectionId(section.section_id);
    setEpubRestoreRequest(
      buildManualSectionRestoreRequest(section.section_id, activeRequestedFragmentId)
    );
  }, [
    activeRequestedEpubLoc,
    activeRequestedFragmentId,
    activeSectionId,
    beginRestoreSession,
    epubSections,
    isEpub,
  ]);

  useEffect(() => {
    restoreSessionIdRef.current = 0;
    initialEpubRestoreResolvedRef.current = false;
    setRestorePhase("idle");
    setEpubRestoreRequest(null);
    scrollRestoreAppliedRef.current = false;
    lastSavedTextAnchorOffsetRef.current = null;
    setTextRestoreSettled(false);
  }, [id]);

  useEffect(() => {
    scrollRestoreAppliedRef.current = false;
    lastSavedTextAnchorOffsetRef.current = null;
    setTextRestoreSettled(false);
  }, [activeContent?.fragmentId]);

  const activeFragmentId = activeContent?.fragmentId ?? null;

  useEffect(() => {
    if (isPdf || !activeFragmentId || readerProfileLoading) {
      setReaderLayoutReady(false);
      return;
    }

    setReaderLayoutReady(false);
    let firstFrame = 0;
    let secondFrame = 0;

    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        setReaderLayoutReady(true);
      });
    });

    return () => {
      if (firstFrame) {
        window.cancelAnimationFrame(firstFrame);
      }
      if (secondFrame) {
        window.cancelAnimationFrame(secondFrame);
      }
    };
  }, [activeFragmentId, id, isPdf, readerLayoutKey, readerProfileLoading]);

  useEffect(() => {
    if (
      isPdf ||
      restorePhase === "idle" ||
      restorePhase === "settled" ||
      restorePhase === "cancelled"
    ) {
      return;
    }

    const container = getPaneScrollContainer(contentRef.current);
    if (!container) {
      return;
    }

    const cancelPendingRestore = () => {
      cancelRestoreSession();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isUserScrollKey(event)) {
        cancelRestoreSession();
      }
    };

    container.addEventListener("wheel", cancelPendingRestore, { passive: true });
    container.addEventListener("touchmove", cancelPendingRestore, { passive: true });
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      container.removeEventListener("wheel", cancelPendingRestore);
      container.removeEventListener("touchmove", cancelPendingRestore);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeContent?.fragmentId, cancelRestoreSession, isPdf, restorePhase]);

  // Restore text locators for web, transcript, and EPUB content.
  useEffect(() => {
    if (isPdf || !activeContent) {
      setTextRestoreSettled(false);
      return;
    }
    if (initialReaderResumeStateLoading || readerProfileLoading || !readerLayoutReady) {
      return;
    }
    if (isMismatchDisabled) {
      void settleRestoreSession(restoreSessionIdRef.current);
      return;
    }
    if (scrollRestoreAppliedRef.current) {
      void settleRestoreSession(restoreSessionIdRef.current);
      return;
    }
    if (isEpub && !epubRestoreRequest) {
      setTextRestoreSettled(true);
      return;
    }

    if (!isEpub && readerResumeSource && activeTextSource && readerResumeSource !== activeTextSource) {
      void settleRestoreSession(restoreSessionIdRef.current);
      return;
    }

    const sessionId = restoreSessionIdRef.current;
    const epubAnchorId = isEpub ? epubRestoreRequest?.anchorId ?? null : null;
    const allowEpubTopFallback = isEpub ? Boolean(epubRestoreRequest?.allowSectionTopFallback) : false;
    const resumeTextOffset = isEpub
      ? epubRestoreRequest?.locations.text_offset ?? null
      : readerResumeTextOffset;
    const resumeQuote = isEpub ? epubRestoreRequest?.text.quote ?? null : readerResumeQuote;
    const resumeQuotePrefix = isEpub
      ? epubRestoreRequest?.text.quote_prefix ?? null
      : readerResumeQuotePrefix;
    const resumeQuoteSuffix = isEpub
      ? epubRestoreRequest?.text.quote_suffix ?? null
      : readerResumeQuoteSuffix;
    const resumeProgression = isEpub
      ? epubRestoreRequest?.locations.progression ?? null
      : readerResumeProgression;
    const resumeTotalProgression = isEpub
      ? epubRestoreRequest?.locations.total_progression ?? null
      : readerResumeTotalProgression;
    const resumePosition = isEpub
      ? epubRestoreRequest?.locations.position ?? null
      : readerResumePosition;

    let resumeOffset = resumeTextOffset;
    if (resumeOffset === null) {
      resumeOffset = findCanonicalOffsetFromQuote(
        activeContent.canonicalText,
        resumeQuote,
        resumeQuotePrefix,
        resumeQuoteSuffix
      );
    }
    if (resumeOffset === null && resumeProgression !== null) {
      resumeOffset = Math.floor(
        canonicalCpLength(activeContent.canonicalText) *
          Math.max(0, Math.min(resumeProgression, 1))
      );
    }
    if (resumeOffset === null && resumeTotalProgression !== null && totalTextLength > 0) {
      const totalOffset = Math.floor(
        totalTextLength * Math.max(0, Math.min(resumeTotalProgression, 1))
      );
      const localOffset = totalOffset - activeTextStartOffset;
      const localLength = canonicalCpLength(activeContent.canonicalText);
      if (localOffset >= 0 && localOffset <= localLength) {
        resumeOffset = localOffset;
      }
    }
    if (resumeOffset === null && resumePosition !== null && totalTextLength > 0) {
      const totalOffset = (resumePosition - 1) * READER_POSITION_BUCKET_CP;
      const localOffset = totalOffset - activeTextStartOffset;
      const localLength = canonicalCpLength(activeContent.canonicalText);
      if (localOffset >= 0 && localOffset <= localLength) {
        resumeOffset = localOffset;
      }
    }
    if (resumeOffset === null) {
      if (isEpub && (epubAnchorId !== null || allowEpubTopFallback)) {
        void updateRestorePhase(sessionId, "restoring_fallback");
        return;
      }
      void settleRestoreSession(sessionId);
      return;
    }

    const container = getPaneScrollContainer(contentRef.current);
    if (!container) {
      return;
    }

    let releaseChromeLock =
      isMobileViewport && paneMobileChrome
        ? paneMobileChrome.acquireVisibleLock("reader-restore")
        : null;
    const releaseChrome = () => {
      releaseChromeLock?.();
      releaseChromeLock = null;
    };

    void updateRestorePhase(sessionId, "restoring_exact");

    let rafId = 0;
    let attempts = 0;
    const maxAttempts = 96;

    const attemptRestore = () => {
      if (sessionId !== restoreSessionIdRef.current) {
        releaseChrome();
        return;
      }
      attempts += 1;
      const cursor = cursorRef.current;
      if (!cursor) {
        if (attempts < maxAttempts) {
          rafId = window.requestAnimationFrame(attemptRestore);
        } else if (isEpub && (epubAnchorId !== null || allowEpubTopFallback)) {
          releaseChrome();
          void updateRestorePhase(sessionId, "restoring_fallback");
        } else {
          releaseChrome();
          void settleRestoreSession(sessionId);
        }
        return;
      }

      const restored = scrollToCanonicalTextAnchor(
        container,
        cursor,
        resumeOffset
      );
      const visible = restored
        ? isCanonicalTextAnchorVisible(container, cursor, resumeOffset)
        : false;
      if (restored && visible) {
        scrollRestoreAppliedRef.current = true;
        lastSavedTextAnchorOffsetRef.current = resumeOffset;
        releaseChrome();
        void settleRestoreSession(sessionId);
      } else if (attempts < maxAttempts) {
        rafId = window.requestAnimationFrame(attemptRestore);
      } else if (isEpub && (epubAnchorId !== null || allowEpubTopFallback)) {
        releaseChrome();
        void updateRestorePhase(sessionId, "restoring_fallback");
      } else {
        releaseChrome();
        void settleRestoreSession(sessionId);
      }
    };

    rafId = window.requestAnimationFrame(attemptRestore);
    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      releaseChrome();
    };
  }, [
    isPdf,
    isEpub,
    activeContent,
    activeTextSource,
    activeTextStartOffset,
    epubRestoreRequest,
    initialReaderResumeStateLoading,
    isMismatchDisabled,
    readerResumeProgression,
    readerResumeQuote,
    readerResumeQuotePrefix,
    readerResumeQuoteSuffix,
    readerResumeSource,
    readerResumeTextOffset,
    readerResumeTotalProgression,
    readerResumePosition,
    readerLayoutReady,
    readerProfileLoading,
    isMobileViewport,
    paneMobileChrome,
    settleRestoreSession,
    totalTextLength,
    updateRestorePhase,
  ]);

  // Persist text locators for web, transcript, and EPUB content.
  useEffect(() => {
    if (
      isPdf ||
      !activeContent ||
      !activeTextSource ||
      isMismatchDisabled ||
      initialReaderResumeStateLoading ||
      !textRestoreSettled
    ) {
      return;
    }
    const container = getPaneScrollContainer(contentRef.current);
    if (!container) {
      return;
    }

    let rafId = 0;
    const handleScroll = () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      rafId = window.requestAnimationFrame(() => {
        const cursor = cursorRef.current;
        if (!cursor) {
          return;
        }
        const anchorOffset = findFirstVisibleCanonicalOffset(container, cursor);
        if (anchorOffset === null) {
          return;
        }
        if (
          !isEpub &&
          !isTranscriptMedia &&
          anchorOffset === 0 &&
          container.scrollTop <= 1 &&
          lastSavedTextAnchorOffsetRef.current === null
        ) {
          return;
        }
        if (lastSavedTextAnchorOffsetRef.current === anchorOffset) {
          return;
        }
        lastSavedTextAnchorOffsetRef.current = anchorOffset;
        const quoteWindow = buildCanonicalQuoteWindow(
          activeContent.canonicalText,
          anchorOffset
        );
        const activeLength = canonicalCpLength(activeContent.canonicalText);
        const absoluteOffset = activeTextStartOffset + anchorOffset;
        const locations = {
          text_offset: anchorOffset,
          progression: activeLength > 0 ? Math.min(1, anchorOffset / activeLength) : 0,
          total_progression:
            totalTextLength > 0 ? Math.min(1, absoluteOffset / totalTextLength) : 0,
          position: Math.floor(absoluteOffset / READER_POSITION_BUCKET_CP) + 1,
        };
        const text = {
          quote: quoteWindow.quote,
          quote_prefix: quoteWindow.quotePrefix,
          quote_suffix: quoteWindow.quoteSuffix,
        };

        if (isEpub && activeEpubSection?.href_path) {
          saveReaderResumeState({
            kind: "epub",
            target: {
              section_id: activeEpubSection.section_id,
              href_path: activeEpubSection.href_path,
              anchor_id: activeTextAnchor,
            },
            locations,
            text,
          });
          return;
        }

        if (isTranscriptMedia) {
          saveReaderResumeState({
            kind: "transcript",
            target: {
              fragment_id: activeTextSource,
            },
            locations,
            text,
          });
          return;
        }

        saveReaderResumeState({
          kind: "web",
          target: {
            fragment_id: activeTextSource,
          },
          locations,
          text,
        });
      });
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => {
      container.removeEventListener("scroll", handleScroll);
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [
    isPdf,
    activeContent,
    activeEpubSection,
    activeTextAnchor,
    activeTextSource,
    activeTextStartOffset,
    initialReaderResumeStateLoading,
    isEpub,
    saveReaderResumeState,
    isMismatchDisabled,
    isTranscriptMedia,
    textRestoreSettled,
    totalTextLength,
  ]);

  // Scroll to anchor target after section content loads.
  useEffect(() => {
    if (
      !isEpub ||
      !epubRestoreRequest ||
      !contentRef.current ||
      !activeEpubSection ||
      epubSectionLoading ||
      readerProfileLoading ||
      !readerLayoutReady ||
      restorePhase !== "restoring_fallback"
    ) {
      return;
    }

    const sessionId = restoreSessionIdRef.current;
    let rafId = 0;
    const MAX_ATTEMPTS = 96;

    let releaseChromeLock =
      isMobileViewport && paneMobileChrome
        ? paneMobileChrome.acquireVisibleLock("reader-restore")
        : null;
    const releaseChrome = () => {
      releaseChromeLock?.();
      releaseChromeLock = null;
    };

    const findTarget = (): HTMLElement | null => {
      const root = contentRef.current;
      if (!root) {
        return null;
      }
      if (!epubRestoreRequest.anchorId) {
        return null;
      }

      const byId =
        Array.from(root.querySelectorAll<HTMLElement>("[id]")).find(
          (el) => el.getAttribute("id") === epubRestoreRequest.anchorId
        ) ?? null;
      if (byId) {
        return byId;
      }

      return (
        Array.from(root.querySelectorAll<HTMLElement>("[name]")).find(
          (el) => el.getAttribute("name") === epubRestoreRequest.anchorId
        ) ?? null
      );
    };

    const attemptScroll = (attempt: number) => {
      if (sessionId !== restoreSessionIdRef.current) {
        releaseChrome();
        return;
      }

      const target = findTarget();
      if (target) {
        target.scrollIntoView({ block: "start", behavior: "auto" });
        scrollRestoreAppliedRef.current = true;
        releaseChrome();
        void settleRestoreSession(sessionId);
        return;
      }

      if (epubRestoreRequest.anchorId && attempt < MAX_ATTEMPTS) {
        rafId = window.requestAnimationFrame(() => attemptScroll(attempt + 1));
        return;
      }

      if (epubRestoreRequest.allowSectionTopFallback) {
        const container = getPaneScrollContainer(contentRef.current);
        if (container) {
          container.scrollTop = 0;
        }
        scrollRestoreAppliedRef.current = true;
      }
      releaseChrome();
      void settleRestoreSession(sessionId);
    };

    attemptScroll(0);

    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      releaseChrome();
    };
  }, [
    activeEpubSection,
    epubRestoreRequest,
    epubSectionLoading,
    isEpub,
    isMobileViewport,
    paneMobileChrome,
    readerLayoutReady,
    readerProfileLoading,
    restorePhase,
    settleRestoreSession,
  ]);

  // ==========================================================================
  // Highlight loading — reacts to active content
  // ==========================================================================

  useEffect(() => {
    if (!activeContent) return;

    const version = ++highlightVersionRef.current;
    let cancelled = false;

    const loadHighlights = async () => {
      const retryDelaysMs = [0, 150, 400];

      for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
        if (retryDelaysMs[attempt]! > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, retryDelaysMs[attempt]));
        }
        if (cancelled || version !== highlightVersionRef.current) {
          return;
        }

        try {
          const data = await fetchHighlights(activeContent.fragmentId);
          if (cancelled || version !== highlightVersionRef.current) {
            return;
          }

          const shouldRetryEmptyEpubResult =
            isEpub && data.length === 0 && attempt < retryDelaysMs.length - 1;
          if (shouldRetryEmptyEpubResult) {
            continue;
          }

          setHighlights(data);
              return;
        } catch (err) {
          if (cancelled || version !== highlightVersionRef.current) {
            return;
          }

          const shouldRetry =
            attempt < retryDelaysMs.length - 1 && (!isApiError(err) || err.status >= 500);
          if (shouldRetry) {
            continue;
          }

          console.error("Failed to load highlights:", err);
          return;
        }
      }
    };

    void loadHighlights();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-fetch when active fragment changes
  }, [activeContent?.fragmentId]);

  // ==========================================================================
  // Highlight Rendering
  // ==========================================================================

  const temporaryTextHighlight = useMemo<HighlightInput | null>(() => {
    const highlight = resolvedEvidence?.resolver.highlight;
    if (highlight) {
      if (!activeContent) {
        return null;
      }
      const kind = highlight.kind;
      if (kind !== "web_text" && kind !== "epub_text" && kind !== "transcript_time_text") {
        return null;
      }
      const fragmentId = highlight.fragment_id;
      const startOffset = highlight.start_offset;
      const endOffset = highlight.end_offset;
      if (
        fragmentId !== activeContent.fragmentId ||
        typeof startOffset !== "number" ||
        typeof endOffset !== "number" ||
        endOffset <= startOffset
      ) {
        if (kind !== "transcript_time_text") {
          return null;
        }
        const exact = textQuoteField(highlight, "exact");
        const prefix = textQuoteField(highlight, "prefix");
        const suffix = textQuoteField(highlight, "suffix");
        const matchedOffset = findCanonicalOffsetFromQuote(
          activeContent.canonicalText,
          exact,
          prefix,
          suffix
        );
        if (matchedOffset === null || !exact) {
          return null;
        }
        return {
          id: `evidence-${resolvedEvidence.evidence_span_id}`,
          start_offset: matchedOffset,
          end_offset: matchedOffset + [...exact].length,
          color: "blue",
          created_at: "1970-01-01T00:00:00.000Z",
        };
      }
      if (kind === "transcript_time_text" && fragmentId !== activeContent.fragmentId) {
        return null;
      }
      return {
        id: `evidence-${resolvedEvidence.evidence_span_id}`,
        start_offset: startOffset,
        end_offset: endOffset,
        color: "blue",
        created_at: "1970-01-01T00:00:00.000Z",
      };
    }

    if (!activeContent || readerSourceTarget?.media_id !== id) {
      return null;
    }
    const locator = readerSourceTarget.locator;
    if (typeof locator !== "object" || locator === null || Array.isArray(locator)) {
      return null;
    }
    const type = locator.type;
    if (type === "reader_text_offsets" || type === "epub_fragment_offsets") {
      const fragmentId = locator.fragment_id;
      const startOffset = locator.start_offset;
      const endOffset = locator.end_offset;
      if (
        fragmentId !== activeContent.fragmentId ||
        typeof startOffset !== "number" ||
        typeof endOffset !== "number" ||
        endOffset <= startOffset
      ) {
        return null;
      }
      return {
        id: `reader-source-${readerSourceTarget.source}-${readerSourceTarget.context_id ?? readerSourceTarget.evidence_id ?? "target"}`,
        start_offset: startOffset,
        end_offset: endOffset,
        color: "blue",
        created_at: "1970-01-01T00:00:00.000Z",
      };
    }
    if (type !== "transcript_time_range") {
      return null;
    }
    const textQuoteSelector = (locator as Record<string, unknown>).text_quote_selector;
    const quoteSelector =
      typeof textQuoteSelector === "object" &&
      textQuoteSelector !== null &&
      !Array.isArray(textQuoteSelector)
        ? (textQuoteSelector as Record<string, unknown>)
        : null;
    const exact =
      readerSourceTarget.snippet ||
      (typeof quoteSelector?.exact === "string"
        ? quoteSelector.exact
        : null);
    if (!exact) {
      return null;
    }
    const prefix =
      typeof quoteSelector?.prefix === "string"
        ? quoteSelector.prefix
        : null;
    const suffix =
      typeof quoteSelector?.suffix === "string"
        ? quoteSelector.suffix
        : null;
    const matchedOffset = findCanonicalOffsetFromQuote(
      activeContent.canonicalText,
      exact,
      prefix,
      suffix
    );
    if (matchedOffset === null) {
      return null;
    }
    return {
      id: `reader-source-${readerSourceTarget.source}-${readerSourceTarget.context_id ?? readerSourceTarget.evidence_id ?? "target"}`,
      start_offset: matchedOffset,
      end_offset: matchedOffset + [...exact].length,
      color: "blue",
      created_at: "1970-01-01T00:00:00.000Z",
    };
  }, [activeContent, id, readerSourceTarget, resolvedEvidence]);

  const resolvedPdfPageNumber = useMemo(() => {
    const highlight = resolvedEvidence?.resolver.highlight;
    if (!highlight || highlight.kind !== "pdf_text") {
      return null;
    }
    const pageNumber = highlight.page_number;
    return typeof pageNumber === "number" && Number.isInteger(pageNumber) && pageNumber >= 1
      ? pageNumber
      : null;
  }, [resolvedEvidence]);

  const temporaryPdfHighlight = useMemo<PdfTemporaryHighlight | null>(() => {
    const highlight = resolvedEvidence?.resolver.highlight;
    if (highlight) {
      if (highlight.kind !== "pdf_text") {
        return null;
      }
      const pageNumber = highlight.page_number;
      const geometry = highlight.geometry;
      if (
        typeof pageNumber !== "number" ||
        !Number.isInteger(pageNumber) ||
        pageNumber < 1 ||
        typeof geometry !== "object" ||
        geometry === null ||
        Array.isArray(geometry)
      ) {
        return null;
      }

      const rawQuads = (geometry as Record<string, unknown>).quads;
      if (!Array.isArray(rawQuads)) {
        return null;
      }

      const quads = rawQuads.flatMap((rawQuad) => {
        if (typeof rawQuad !== "object" || rawQuad === null || Array.isArray(rawQuad)) {
          return [];
        }
        const quad = rawQuad as Record<string, unknown>;
        const x1 = quad.x1;
        const y1 = quad.y1;
        const x2 = quad.x2;
        const y2 = quad.y2;
        const x3 = quad.x3;
        const y3 = quad.y3;
        const x4 = quad.x4;
        const y4 = quad.y4;
        if (
          typeof x1 !== "number" ||
          typeof y1 !== "number" ||
          typeof x2 !== "number" ||
          typeof y2 !== "number" ||
          typeof x3 !== "number" ||
          typeof y3 !== "number" ||
          typeof x4 !== "number" ||
          typeof y4 !== "number"
        ) {
          return [];
        }
        return [{ x1, y1, x2, y2, x3, y3, x4, y4 }];
      });
      if (quads.length === 0) {
        return null;
      }
      return {
        id: `evidence-${resolvedEvidence.evidence_span_id}`,
        pageNumber,
        quads,
        color: "blue",
      };
    }

    if (readerSourceTarget?.media_id !== id) {
      return null;
    }
    const locator = readerSourceTarget.locator;
    if (typeof locator !== "object" || locator === null || Array.isArray(locator)) {
      return null;
    }
    const type = locator.type;
    if (type !== "pdf_page_geometry" && type !== "pdf_text_quote") {
      return null;
    }
    const pageNumber = locator.page_number;
    const rawQuads = locator.quads;
    if (
      typeof pageNumber !== "number" ||
      !Number.isInteger(pageNumber) ||
      pageNumber < 1 ||
      !Array.isArray(rawQuads)
    ) {
      return null;
    }
    const quads = rawQuads.flatMap((rawQuad) => {
      if (typeof rawQuad !== "object" || rawQuad === null || Array.isArray(rawQuad)) {
        return [];
      }
      const quad = rawQuad as Record<string, unknown>;
      const x1 = quad.x1;
      const y1 = quad.y1;
      const x2 = quad.x2;
      const y2 = quad.y2;
      const x3 = quad.x3;
      const y3 = quad.y3;
      const x4 = quad.x4;
      const y4 = quad.y4;
      if (
        typeof x1 !== "number" ||
        typeof y1 !== "number" ||
        typeof x2 !== "number" ||
        typeof y2 !== "number" ||
        typeof x3 !== "number" ||
        typeof y3 !== "number" ||
        typeof x4 !== "number" ||
        typeof y4 !== "number"
      ) {
        return [];
      }
      return [{ x1, y1, x2, y2, x3, y3, x4, y4 }];
    });
    if (quads.length === 0) {
      return null;
    }
    return {
      id: `reader-source-${readerSourceTarget.source}-${readerSourceTarget.context_id ?? readerSourceTarget.evidence_id ?? "target"}`,
      pageNumber,
      quads,
      color: "blue",
    };
  }, [id, readerSourceTarget, resolvedEvidence]);

  const renderedHtml = useMemo(
    () =>
      activeContent
        ? applyHighlightsToHtml(
            activeContent.htmlSanitized,
            activeContent.canonicalText,
            activeContent.fragmentId,
            [
              ...highlights.map((highlight) => ({
                id: highlight.id,
                start_offset: highlight.anchor.start_offset,
                end_offset: highlight.anchor.end_offset,
                color: highlight.color,
                created_at: highlight.created_at,
              })),
              ...(temporaryTextHighlight ? [temporaryTextHighlight] : []),
            ] as HighlightInput[]
          ).html
        : "",
    [activeContent, highlights, temporaryTextHighlight]
  );

  // ==========================================================================
  // Canonical Cursor Building
  // ==========================================================================

  useEffect(() => {
    if (!activeContent) {
      cursorRef.current = null;
      setIsMismatchDisabled(false);
      return;
    }
    if (!contentRef.current) {
      cursorRef.current = null;
      setIsMismatchDisabled(false);
      return;
    }

    const cursor = buildCanonicalCursor(contentRef.current);
    const isValid = validateCanonicalText(
      cursor,
      activeContent.canonicalText,
      activeContent.fragmentId
    );

    cursorRef.current = cursor;
    setIsMismatchDisabled(!isValid);
    if (!isValid && mismatchLoggedFragmentRef.current !== activeContent.fragmentId) {
      mismatchLoggedFragmentRef.current = activeContent.fragmentId;
      console.error("highlight_canonical_mismatch_defect", {
        fragmentId: activeContent.fragmentId,
        emittedLength: cursor.length,
        expectedLength: [...activeContent.canonicalText].length,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild when rendered content changes
  }, [activeContent?.fragmentId, activeContent?.canonicalText, renderedHtml]);

  useEffect(() => {
    mismatchToastFragmentRef.current = null;
    mismatchLoggedFragmentRef.current = null;
  }, [activeContent?.fragmentId]);

  // ==========================================================================
  // Focus Sync
  // ==========================================================================

  useEffect(() => {
    if (!contentRef.current) return;
    applyFocusClass(contentRef.current, focusState.focusedId);
  }, [focusState.focusedId]);

  useEffect(() => {
    if (!requestedHighlightId) {
      urlHighlightAppliedRef.current = null;
      return;
    }
    if (!activeContent || !contentRef.current || epubSectionLoading) {
      return;
    }
    if (urlHighlightAppliedRef.current === requestedHighlightId) {
      return;
    }
    if (!highlights.some((item) => item.id === requestedHighlightId)) {
      return;
    }

    const escapedId = escapeAttrValue(requestedHighlightId);
    const anchor = contentRef.current.querySelector<HTMLElement>(
      `[data-highlight-anchor="${escapedId}"]`
    );
    let unlockChromeFrame = 0;
    let releaseChromeLock: (() => void) | null = null;
    if (anchor) {
      if (isMobileViewport && paneMobileChrome) {
        releaseChromeLock = paneMobileChrome.acquireVisibleLock("highlight-navigation");
        unlockChromeFrame = window.requestAnimationFrame(() => {
          releaseChromeLock?.();
          releaseChromeLock = null;
        });
      }
      anchor.scrollIntoView({ behavior: "auto", block: "center" });
    }
    focusHighlight(requestedHighlightId);
    urlHighlightAppliedRef.current = requestedHighlightId;
    return () => {
      if (unlockChromeFrame) {
        window.cancelAnimationFrame(unlockChromeFrame);
      }
      releaseChromeLock?.();
    };
  }, [
    requestedHighlightId,
    activeContent,
    epubSectionLoading,
    highlights,
    renderedHtml,
    focusHighlight,
    isMobileViewport,
    paneMobileChrome,
  ]);

  useEffect(() => {
    if (!requestedEvidenceId || !temporaryTextHighlight) {
      urlEvidenceAppliedRef.current = null;
      return;
    }
    if (!activeContent || !contentRef.current || epubSectionLoading) {
      return;
    }
    if (urlEvidenceAppliedRef.current === temporaryTextHighlight.id) {
      return;
    }

    const escapedId = escapeAttrValue(temporaryTextHighlight.id);
    const anchor = contentRef.current.querySelector<HTMLElement>(
      `[data-highlight-anchor="${escapedId}"]`
    );
    let unlockChromeFrame = 0;
    let releaseChromeLock: (() => void) | null = null;
    if (anchor) {
      if (isMobileViewport && paneMobileChrome) {
        releaseChromeLock = paneMobileChrome.acquireVisibleLock("highlight-navigation");
        unlockChromeFrame = window.requestAnimationFrame(() => {
          releaseChromeLock?.();
          releaseChromeLock = null;
        });
      }
      anchor.scrollIntoView({ behavior: "auto", block: "center" });
    }
    urlEvidenceAppliedRef.current = temporaryTextHighlight.id;
    return () => {
      if (unlockChromeFrame) {
        window.cancelAnimationFrame(unlockChromeFrame);
      }
      releaseChromeLock?.();
    };
  }, [
    requestedEvidenceId,
    activeContent,
    epubSectionLoading,
    isMobileViewport,
    paneMobileChrome,
    renderedHtml,
    temporaryTextHighlight,
  ]);

  // ==========================================================================
  // Selection Handling
  // ==========================================================================

  const handleSelectionChange = useCallback(() => {
    if (isPdf) {
      clearRetainedSelection(false);
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !contentRef.current) {
      clearPendingMobileSelectionPublish();
      if (!selectionVisibleRef.current || focusState.editingBounds) {
        clearRetainedSelection(false);
      }
      return;
    }

    const range = sel.getRangeAt(0);
    if (!contentRef.current.contains(range.commonAncestorContainer)) {
      clearRetainedSelection(false);
      return;
    }

    if (isMismatchDisabled) {
      clearRetainedSelection(false);
      const mismatchKey = activeContent?.fragmentId ?? "__unknown__";
      if (mismatchToastFragmentRef.current !== mismatchKey) {
        mismatchToastFragmentRef.current = mismatchKey;
        feedback.show({
          severity: "warning",
          title: "Highlights disabled due to content mismatch.",
        });
      }
      return;
    }

    if (!activeContent || !cursorRef.current) {
      clearRetainedSelection(false);
      return;
    }

    const result = selectionToOffsets(
      range,
      cursorRef.current,
      activeContent.canonicalText
    );

    if (!result.success) {
      clearRetainedSelection(false);
      return;
    }

    const rect = range.getBoundingClientRect();
    const lineRects = Array.from(range.getClientRects()).filter(
      (clientRect) => clientRect.width > 0 && clientRect.height > 0
    );
    const nextSelection = {
      fragmentId: activeContent.fragmentId,
      startOffset: result.startOffset,
      endOffset: result.endOffset,
      selectedText: result.selectedText,
      rect,
      lineRects: lineRects.length > 0 ? lineRects : [rect],
    };
    const nextSelectionKey = buildSelectionSnapshotKey(nextSelection);
    const previousSelectionKey = selectionSnapshotKeyRef.current;
    selectionSnapshotRef.current = nextSelection;
    selectionSnapshotKeyRef.current = nextSelectionKey;

    if (!isMobileViewport || focusState.editingBounds) {
      clearPendingMobileSelectionPublish();
      publishSelection(nextSelection);
      return;
    }

    if (
      previousSelectionKey === nextSelectionKey &&
      (selectionVisibleRef.current || mobileSelectionTimerRef.current != null)
    ) {
      return;
    }

    clearPendingMobileSelectionPublish();
    publishSelection(null);
    mobileSelectionTimerRef.current = window.setTimeout(() => {
      mobileSelectionTimerRef.current = null;
      if (
        selectionSnapshotKeyRef.current !== nextSelectionKey ||
        selectionSnapshotRef.current == null
      ) {
        return;
      }
      publishSelection(selectionSnapshotRef.current);
    }, MOBILE_SELECTION_STABILIZATION_DELAY_MS);
  }, [
    activeContent,
    clearPendingMobileSelectionPublish,
    clearRetainedSelection,
    focusState.editingBounds,
    isMismatchDisabled,
    isMobileViewport,
    isPdf,
    publishSelection,
    feedback,
  ]);

  useEffect(() => {
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [handleSelectionChange]);

  // ==========================================================================
  // Highlight Creation
  // ==========================================================================

  const handleCreateHighlight = useCallback(
    async (color: HighlightColor): Promise<string | null> => {
      const activeSelection = selection ?? selectionSnapshotRef.current;
      if (!activeSelection || !activeContent || isCreating) return null;

      if (isMismatchDisabled) {
        feedback.show({
          severity: "warning",
          title: "Highlights disabled due to content mismatch.",
        });
        clearRetainedSelection(false);
        return null;
      }

      if (activeSelection.fragmentId !== activeContent.fragmentId) {
        feedback.show({
          severity: "warning",
          title: "Selection changed. Select text again.",
        });
        clearRetainedSelection(false);
        return null;
      }

      const duplicateId =
        highlights.find(
          (highlight) =>
            highlight.anchor.start_offset === activeSelection.startOffset &&
            highlight.anchor.end_offset === activeSelection.endOffset
        )?.id ?? null;

      if (duplicateId) {
        focusHighlight(duplicateId);
        clearRetainedSelection(true);
        return duplicateId;
      }

      setIsCreating(true);

      try {
        const requestVersion = ++highlightVersionRef.current;
        const createdHighlight = await createHighlight(
          activeSelection.fragmentId,
          activeSelection.startOffset,
          activeSelection.endOffset,
          color
        );
        if (requestVersion !== highlightVersionRef.current) {
          return null;
        }

        setHighlights((prev) =>
          [...prev.filter((h) => h.id !== createdHighlight.id), createdHighlight].sort((a, b) => {
            if (a.anchor.start_offset !== b.anchor.start_offset) {
              return a.anchor.start_offset - b.anchor.start_offset;
            }
            if (a.anchor.end_offset !== b.anchor.end_offset) {
              return a.anchor.end_offset - b.anchor.end_offset;
            }
            if (a.created_at !== b.created_at) return a.created_at.localeCompare(b.created_at);
            return a.id.localeCompare(b.id);
          })
        );
          focusHighlight(createdHighlight.id);
        clearRetainedSelection(true);

        void fetchHighlights(activeContent.fragmentId)
          .then((newHighlights) => {
            if (requestVersion !== highlightVersionRef.current) {
              return;
            }
            setHighlights(newHighlights);
                })
          .catch((err) => {
            console.error("Failed to refresh highlights after create:", err);
          });
        return createdHighlight.id;
      } catch (err) {
        if (isApiError(err) && err.code === "E_HIGHLIGHT_CONFLICT") {
          try {
            const requestVersion = ++highlightVersionRef.current;
            const newHighlights = await fetchHighlights(activeContent.fragmentId);
            if (requestVersion !== highlightVersionRef.current) {
              return null;
            }
            setHighlights(newHighlights);
      
            const existing = newHighlights.find(
              (h) =>
                h.anchor.start_offset === activeSelection.startOffset &&
                h.anchor.end_offset === activeSelection.endOffset
            );
            if (existing) {
              focusHighlight(existing.id);
            }

            clearRetainedSelection(true);
            return existing?.id ?? null;
          } catch (refreshErr) {
            console.error("Failed to refresh highlights after conflict:", refreshErr);
            feedback.show({
              severity: "error",
              title: "Failed to resolve existing highlight",
            });
            return null;
          }
        } else {
          console.error("Failed to create highlight:", err);
          feedback.show({ severity: "error", title: "Failed to create highlight" });
          return null;
        }
      } finally {
        setIsCreating(false);
      }
      return null;
    },
    [
      selection,
      activeContent,
      clearRetainedSelection,
      isCreating,
      isMismatchDisabled,
      highlights,
      focusHighlight,
      feedback,
    ]
  );

  const handleDismissPopover = useCallback(() => {
    clearRetainedSelection(false);
  }, [clearRetainedSelection]);

  const handleTranscriptSegmentSelect = useCallback(
    (fragment: TranscriptFragment) => {
      cancelRestoreSession();
      setActiveTranscriptFragmentId(fragment.id);
      clearFocus();
      setHighlights([]);
      clearRetainedSelection(false);
    },
    [cancelRestoreSession, clearFocus, clearRetainedSelection]
  );

  // ==========================================================================
  // Highlight Click Handling
  // ==========================================================================

  const handleReaderContentClick = useCallback(
    (e: React.MouseEvent): string | null => {
      const target = e.target as Element;
      const highlightEl = findHighlightElement(target);

      if (highlightEl) {
        const clickData = parseHighlightElement(highlightEl);
        if (clickData) {
          handleHighlightClick(clickData);
          return clickData.topmostId;
        }
      }

      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        clearFocus();
      }
      return null;
    },
    [
      clearFocus,
      handleHighlightClick,
    ]
  );

  // ==========================================================================
  // Edit Bounds Mode
  // ==========================================================================

  useEffect(() => {
    if (
      isPdf ||
      !focusState.editingBounds ||
      !selection ||
      !activeContent
    )
      return;

    const focusedHighlight = highlights.find(
      (h) => h.id === focusState.focusedId
    );
    if (!focusedHighlight || selection.fragmentId !== activeContent.fragmentId || isMismatchDisabled) {
      return;
    }

    const updateBounds = async () => {
      try {
        const requestVersion = ++highlightVersionRef.current;
        await updateHighlight(focusedHighlight.id, {
          anchor: {
            start_offset: selection.startOffset,
            end_offset: selection.endOffset,
          },
        });

        const newHighlights = await fetchHighlights(activeContent.fragmentId);
        if (requestVersion !== highlightVersionRef.current) {
          return;
        }
        setHighlights(newHighlights);
  
        const newIds = new Set(newHighlights.map((h) => h.id));
        const reconciledFocus = reconcileFocusAfterRefetch(
          focusState.focusedId,
          newIds
        );
        if (reconciledFocus !== focusState.focusedId) {
          focusHighlight(reconciledFocus);
        }

        cancelEditBounds();
        clearRetainedSelection(true);
      } catch (err) {
        console.error("Failed to update bounds:", err);
        feedback.show({ severity: "error", title: "Failed to update highlight bounds" });
      }
    };

    updateBounds();
  }, [
    focusState.editingBounds,
    focusState.focusedId,
    isPdf,
    selection,
    activeContent,
    isMismatchDisabled,
    highlights,
    clearRetainedSelection,
    focusHighlight,
    cancelEditBounds,
    feedback,
  ]);

  // ==========================================================================
  // Highlight Editing Callbacks
  // ==========================================================================

  const handleColorChange = useCallback(
    async (highlightId: string, color: HighlightColor) => {
      if (isPdf) {
        await updateHighlight(highlightId, { color });
        setPdfRefreshToken((v) => v + 1);
        return;
      }
      if (!activeContent) return;
      const requestVersion = ++highlightVersionRef.current;
      await updateHighlight(highlightId, { color });
      const newHighlights = await fetchHighlights(activeContent.fragmentId);
      if (requestVersion !== highlightVersionRef.current) {
        return;
      }
      setHighlights(newHighlights);
    },
    [activeContent, isPdf]
  );

  const handleDelete = useCallback(
    async (highlightId: string) => {
      if (isPdf) {
        await deleteHighlight(highlightId);
        setPdfRefreshToken((v) => v + 1);
        clearFocus();
        return;
      }
      if (!activeContent) return;
      const requestVersion = ++highlightVersionRef.current;
      await deleteHighlight(highlightId);
      const newHighlights = await fetchHighlights(activeContent.fragmentId);
      if (requestVersion !== highlightVersionRef.current) {
        return;
      }
      setHighlights(newHighlights);
      clearFocus();
    },
    [activeContent, clearFocus, isPdf]
  );

  const handleNoteSave = useCallback(
    async (
      highlightId: string,
      noteBlockId: string | null,
      createBlockId: string,
      bodyPmJson: Record<string, unknown>
    ) => {
      if (isPdf) {
        if (noteBlockId) {
          await updateNoteBlock(noteBlockId, { bodyPmJson });
        } else {
          await createNoteBlock({
            id: createBlockId,
            bodyPmJson,
            linkedObject: { objectType: "highlight", objectId: highlightId },
            relationType: "note_about",
          });
        }
        setPdfRefreshToken((v) => v + 1);
        return;
      }
      if (!activeContent) return;
      const requestVersion = ++highlightVersionRef.current;
      if (noteBlockId) {
        await updateNoteBlock(noteBlockId, { bodyPmJson });
      } else {
        await createNoteBlock({
          id: createBlockId,
          bodyPmJson,
          linkedObject: { objectType: "highlight", objectId: highlightId },
          relationType: "note_about",
        });
      }
      const newHighlights = await fetchHighlights(activeContent.fragmentId);
      if (requestVersion !== highlightVersionRef.current) {
        return;
      }
      setHighlights(newHighlights);
    },
    [activeContent, isPdf]
  );

  const handleNoteDelete = useCallback(
    async (noteBlockId: string) => {
      if (isPdf) {
        await deleteNoteBlock(noteBlockId);
        setPdfRefreshToken((v) => v + 1);
        return;
      }
      if (!activeContent) return;
      const requestVersion = ++highlightVersionRef.current;
      await deleteNoteBlock(noteBlockId);
      const newHighlights = await fetchHighlights(activeContent.fragmentId);
      if (requestVersion !== highlightVersionRef.current) {
        return;
      }
      setHighlights(newHighlights);
    },
    [activeContent, isPdf]
  );

  // ==========================================================================
  // Quote-to-Chat
  // ==========================================================================

  const activeChatHighlights = isPdf ? pdfHighlightsPaneState.highlights : highlights;

  const buildHighlightChatContext = useCallback(
    (highlightId: string): ContextItem => {
      const highlight = activeChatHighlights.find((item) => item.id === highlightId);
      const exact = highlight?.exact;
      const preview = exact ? exact.slice(0, 120) : undefined;
      const color = highlight?.color;

      return {
        kind: "object_ref",
        type: "highlight",
        id: highlightId,
        ...(color ? { color } : {}),
        ...(preview ? { preview } : {}),
        ...(exact ? { exact } : {}),
        ...(media?.id ? { mediaId: media.id } : {}),
        ...(media?.title ? { mediaTitle: media.title } : {}),
        ...(media?.kind ? { mediaKind: media.kind } : {}),
      };
    },
    [activeChatHighlights, media?.id, media?.kind, media?.title]
  );

  const buildMediaConversationScope = useCallback(
    (): ConversationScope =>
      media
        ? {
            type: "media",
            media_id: media.id,
            title: media.title,
            media_kind: media.kind,
            contributors: media.contributors,
            published_date: media.published_date,
            publisher: media.publisher,
            canonical_source_url: media.canonical_source_url,
          }
        : { type: "general" },
    [media]
  );

  const openReaderAssistant = useCallback(
    (contexts: ContextItem[], conversationScope: ConversationScope = buildMediaConversationScope()) => {
      setReaderAssistantState((current) => {
        let currentScopeKey = "";
        if (current?.conversationScope.type === "general") {
          currentScopeKey = "general";
        } else if (current?.conversationScope.type === "media") {
          currentScopeKey = `media:${current.conversationScope.media_id}`;
        } else if (current?.conversationScope.type === "library") {
          currentScopeKey = `library:${current.conversationScope.library_id}`;
        }

        let nextScopeKey = "general";
        if (conversationScope.type === "media") {
          nextScopeKey = `media:${conversationScope.media_id}`;
        } else if (conversationScope.type === "library") {
          nextScopeKey = `library:${conversationScope.library_id}`;
        }

        const nextContexts =
          current && currentScopeKey === nextScopeKey ? [...current.contexts] : [];
        const seen = new Set(
          nextContexts.map((context) =>
            context.kind === "reader_selection"
              ? `reader_selection:${context.client_context_id}`
              : `${context.type}:${context.id}:${context.evidence_span_ids?.join(",") ?? ""}`,
          ),
        );
        for (const context of contexts) {
          const key =
            context.kind === "reader_selection"
              ? `reader_selection:${context.client_context_id}`
              : `${context.type}:${context.id}:${context.evidence_span_ids?.join(",") ?? ""}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          nextContexts.push(context);
        }
        return {
          contexts: nextContexts,
          conversationId:
            current && currentScopeKey === nextScopeKey ? current.conversationId : null,
          conversationScope,
        };
      });
      setHighlightsInspectorOpen(false);
    },
    [buildMediaConversationScope],
  );

  const handleOpenConversation = useCallback(
    (conversationId: string, title: string) => {
      const route = `/conversations/${conversationId}`;
      if (!requestOpenInAppPane(route, { titleHint: title })) {
        router.push(route);
      }
    },
    [router]
  );

  // ==========================================================================
  // EPUB Section Navigation
  // ==========================================================================

  const navigateToSection = useCallback(
    (sectionId: string, anchorId: string | null = null) => {
      const section = epubSections?.find((item) => item.section_id === sectionId);
      if (!section) return;
      beginRestoreSession("opening_target");
      setEpubRestoreRequest(buildManualSectionRestoreRequest(sectionId, anchorId));
      if (sectionId === activeSectionId) {
        return;
      }
      router.push(buildEpubLocationHref(id, sectionId));
      setActiveSectionId(sectionId);
      setActiveEpubSection(null);
    },
    [activeSectionId, beginRestoreSession, epubSections, id, router]
  );

  const activeSectionPosition = useMemo(() => {
    if (!epubSections || !activeSectionId) {
      return -1;
    }
    return epubSections.findIndex((section) => section.section_id === activeSectionId);
  }, [activeSectionId, epubSections]);
  const prevSection =
    activeSectionPosition > 0 && epubSections
      ? epubSections[activeSectionPosition - 1]
      : null;
  const nextSection =
    activeSectionPosition >= 0 &&
    epubSections &&
    activeSectionPosition < epubSections.length - 1
      ? epubSections[activeSectionPosition + 1]
      : null;
  const hasEpubToc = epubToc !== null && epubToc.length > 0;

  const handlePdfPageHighlightsChange = useCallback(
    (nextPage: number, nextHighlights: PdfHighlightOut[]) => {
      setPdfHighlightsPaneState((current) => ({
        activePage: nextPage,
        highlights: nextHighlights,
        version: current.version + 1,
      }));
      setPdfDocumentHighlights((current) => {
        const filtered = current.filter(
          (highlight) => highlight.anchor.page_number !== nextPage,
        );
        return [...filtered, ...nextHighlights];
      });

      const focusedHighlightId = focusedHighlightIdRef.current;
      if (
        focusedHighlightId &&
        !nextHighlights.some((highlight) => highlight.id === focusedHighlightId)
      ) {
        clearFocus();
      }
    },
    [clearFocus]
  );

  const pdfReaderResumeState = initialPdfResumeState;
  const readerResumeStateLoading = initialReaderResumeStateLoading;
  const activeChapter = activeEpubSection;
  const chapterLoading = epubSectionLoading;
  const handleMediaContentClick = handleReaderContentClick;

  const { setTrack, seekToMs, play } = useGlobalPlayer();
  const readerFontFamily =
    readerProfile.font_family === "sans"
      ? "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
      : "Iowan Old Style, Palatino Linotype, Book Antiqua, Palatino, Georgia, Times New Roman, serif";
  const readerSurfaceStyle = {
    "--reader-font-family": readerFontFamily,
    "--reader-font-size-px": `${readerProfile.font_size_px}px`,
    "--reader-line-height": String(readerProfile.line_height),
    "--reader-column-width-ch": `${readerProfile.column_width_ch}ch`,
  } as CSSProperties;
  const readerSurfaceClassName = `${styles.readerContentRoot} ${
    readerProfile.theme === "dark" ? styles.readerThemeDark : styles.readerThemeLight
  }`;
  const readerRootRef = useRef<HTMLDivElement | null>(null);
  const [chromeRevealed, setChromeRevealed] = useState(false);
  const focusModeForRoot = readerProfile.focus_mode;
  const hyphenationForRoot = readerProfile.hyphenation;

  // Cmd/Ctrl+Shift+F cycles focus mode; Esc returns to off.
  // Suppress when typing in form fields or contenteditable surfaces.
  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      const isCycle =
        event.shiftKey &&
        (event.metaKey || event.ctrlKey) &&
        (event.key === "f" || event.key === "F");
      if (isCycle) {
        event.preventDefault();
        const current = readerProfile.focus_mode;
        const next: typeof current =
          current === "off"
            ? "distraction_free"
            : current === "distraction_free"
              ? "paragraph"
              : current === "paragraph"
                ? "sentence"
                : "off";
        saveReaderProfile({ focus_mode: next });
        return;
      }
      if (event.key === "Escape" && readerProfile.focus_mode !== "off") {
        saveReaderProfile({ focus_mode: "off" });
      }
    }
    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [readerProfile.focus_mode, saveReaderProfile]);

  // IntersectionObserver tracks the paragraph nearest viewport vertical center.
  // For sentence mode, segment the active paragraph's text via Intl.Segmenter
  // and mark the sentence containing the line nearest the center. Without
  // Intl.Segmenter, sentence mode silently behaves like paragraph mode.
  useEffect(() => {
    if (focusModeForRoot !== "paragraph" && focusModeForRoot !== "sentence") {
      return;
    }
    const root = readerRootRef.current;
    if (!root) return;

    function clearSentenceMarkers(paragraph: Element) {
      for (const node of Array.from(
        paragraph.querySelectorAll<HTMLElement>('[data-sentence-current="true"]')
      )) {
        node.removeAttribute("data-sentence-current");
      }
      const wrapped = paragraph.querySelector<HTMLElement>('[data-sentence-wrap="true"]');
      if (wrapped) {
        const original = wrapped.getAttribute("data-sentence-original");
        if (original !== null) {
          paragraph.textContent = original;
        }
      }
    }

    function markSentenceNearViewportCenter(paragraph: Element) {
      const SegmenterCtor = (
        globalThis as { Intl: typeof Intl & { Segmenter?: typeof Intl.Segmenter } }
      ).Intl.Segmenter;
      if (!SegmenterCtor) return;
      // Only segment plain-text paragraphs. If the paragraph contains
      // element children (highlights, links, code, etc.), rewriting the DOM
      // would destroy that structure, so silently downgrade to paragraph-only
      // emphasis.
      if (paragraph.childElementCount !== 0) return;
      const text = paragraph.textContent ?? "";
      if (text.length === 0) return;

      const segmenter = new SegmenterCtor(undefined, { granularity: "sentence" });
      const segments = Array.from(segmenter.segment(text));
      if (segments.length === 0) return;

      const originalText = text;
      const fragment = document.createDocumentFragment();
      for (const segment of segments) {
        const span = document.createElement("span");
        span.setAttribute("data-sentence", "true");
        span.textContent = segment.segment;
        fragment.appendChild(span);
      }
      const sentinel = document.createElement("span");
      sentinel.setAttribute("data-sentence-wrap", "true");
      sentinel.setAttribute("data-sentence-original", originalText);
      sentinel.style.display = "contents";
      sentinel.appendChild(fragment);
      paragraph.replaceChildren(sentinel);

      const center = window.innerHeight / 2;
      let bestEl: HTMLElement | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const el of Array.from(
        paragraph.querySelectorAll<HTMLElement>('[data-sentence="true"]')
      )) {
        const rect = el.getBoundingClientRect();
        const sentenceCenter = rect.top + rect.height / 2;
        const distance = Math.abs(sentenceCenter - center);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestEl = el;
        }
      }
      if (bestEl) {
        bestEl.setAttribute("data-sentence-current", "true");
      }
    }

    function pickCenteredParagraph(scope: HTMLElement): Element | null {
      const paragraphs = Array.from(
        scope.querySelectorAll<HTMLElement>('[data-paragraph="true"]')
      );
      if (paragraphs.length === 0) return null;
      const center = window.innerHeight / 2;
      let bestEl: Element | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const el of paragraphs) {
        const rect = el.getBoundingClientRect();
        if (rect.height === 0) continue;
        const elementCenter = rect.top + rect.height / 2;
        const distance = Math.abs(elementCenter - center);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestEl = el;
        }
      }
      return bestEl;
    }

    let lastCurrent: Element | null = null;
    const scopedRoot = root;

    const applyCurrent = () => {
      const next = pickCenteredParagraph(scopedRoot);
      const previous = lastCurrent;
      if (next === previous) return;
      if (previous) {
        previous.removeAttribute("data-paragraph-current");
        clearSentenceMarkers(previous);
      }
      if (next) {
        next.setAttribute("data-paragraph-current", "true");
        if (focusModeForRoot === "sentence") {
          markSentenceNearViewportCenter(next);
        }
      }
      lastCurrent = next;
    };

    const observer = new IntersectionObserver(applyCurrent, {
      rootMargin: "0px",
      threshold: [0, 0.25, 0.5, 0.75, 1],
    });
    const paragraphs = Array.from(
      root.querySelectorAll<HTMLElement>('[data-paragraph="true"]')
    );
    for (const paragraph of paragraphs) {
      observer.observe(paragraph);
    }
    applyCurrent();
    window.addEventListener("scroll", applyCurrent, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", applyCurrent);
      if (lastCurrent) {
        lastCurrent.removeAttribute("data-paragraph-current");
        clearSentenceMarkers(lastCurrent);
      }
    };
  }, [focusModeForRoot, renderedHtml]);

  // Distraction-free chrome reveal: pointer movement keeps chrome visible for
  // ~3 seconds of idle time. Exits silently in the off case.
  useEffect(() => {
    if (focusModeForRoot === "off") {
      setChromeRevealed(false);
      return;
    }
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    function handlePointerMove() {
      setChromeRevealed(true);
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        setChromeRevealed(false);
      }, 3000);
    }
    window.addEventListener("pointermove", handlePointerMove);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, [focusModeForRoot]);

  // Selection-active mirror on the reader root so focus mode dimming auto-suspends.
  useEffect(() => {
    const root = readerRootRef.current;
    if (!root) return;
    function handleSelectionChange() {
      const root = readerRootRef.current;
      if (!root) return;
      const selection = document.getSelection();
      const isActive =
        selection !== null &&
        !selection.isCollapsed &&
        selection.rangeCount > 0 &&
        root.contains(selection.getRangeAt(0).commonAncestorContainer);
      if (isActive) {
        root.setAttribute("data-selection-active", "true");
      } else {
        root.removeAttribute("data-selection-active");
      }
    }
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, []);

  // ==========================================================================
  // Highlights pane state
  // ==========================================================================

  const [isHighlightsInspectorOpen, setHighlightsInspectorOpen] = useState(false);
  const [readerScrollContainer, setReaderScrollContainer] =
    useState<HTMLElement | null>(null);
  const [libraryPanelOpen, setLibraryPanelOpen] = useState(false);
  const [libraryPanelAnchorEl, setLibraryPanelAnchorEl] =
    useState<HTMLElement | null>(null);
  const [libraryPickerLibraries, setLibraryPickerLibraries] = useState<
    LibraryTargetPickerItem[]
  >([]);
  const [libraryPickerLoading, setLibraryPickerLoading] = useState(false);
  const [libraryPickerError, setLibraryPickerError] = useState<string | null>(null);
  const [libraryMembershipBusy, setLibraryMembershipBusy] = useState(false);
  const [documentDeleteBusy, setDocumentDeleteBusy] = useState(false);
  const [retryProcessingBusy, setRetryProcessingBusy] = useState(false);
  const [refreshSourceBusy, setRefreshSourceBusy] = useState(false);
  const [videoSeekTargetMs, setVideoSeekTargetMs] = useState<number | null>(null);
  const resumeNoticeMediaIdRef = useRef<string | null>(null);
  const seededPodcastTrackRef = useRef<string | null>(null);

  useEffect(() => {
    if (!media?.id) {
      setLibraryPickerLibraries([]);
      setLibraryPickerError(null);
    }
  }, [media?.id]);

  const loadLibraryPickerLibraries = useCallback(async () => {
    if (!media?.id) {
      setLibraryPickerLibraries([]);
      setLibraryPickerError(null);
      return;
    }
    setLibraryPickerLoading(true);
    setLibraryPickerError(null);
    try {
      const response = await apiFetch<{
        data: Array<{
          id: string;
          name: string;
          color: string | null;
          is_default?: boolean;
          is_in_library: boolean;
          can_add: boolean;
          can_remove: boolean;
        }>;
      }>(`/api/media/${media.id}/libraries`);
      setLibraryPickerLibraries(
        response.data
          .filter((library) => !library.is_default)
          .map((library) => ({
            id: library.id,
            name: library.name,
            color: library.color,
            isInLibrary: library.is_in_library,
            canAdd: library.can_add,
            canRemove: library.can_remove,
          }))
      );
    } catch (err) {
      setLibraryPickerLibraries([]);
      setLibraryPickerError(toFeedback(err, { fallback: "Failed to load libraries" }).title);
    } finally {
      setLibraryPickerLoading(false);
    }
  }, [media?.id]);

  useEffect(() => {
    if (!readerAssistantState || !media?.id) {
      return;
    }
    void loadLibraryPickerLibraries();
  }, [loadLibraryPickerLibraries, media?.id, readerAssistantState]);

  const handleAddToLibrary = useCallback(
    async (libraryId: string) => {
      if (!media?.id || libraryMembershipBusy) {
        return;
      }
      setLibraryMembershipBusy(true);
      setLibraryPickerError(null);
      try {
        await apiFetch(`/api/libraries/${libraryId}/media`, {
          method: "POST",
          body: JSON.stringify({ media_id: media.id }),
        });
        setLibraryPickerLibraries((current) =>
          current.map((library) =>
            library.id === libraryId
              ? {
                  ...library,
                  isInLibrary: true,
                  canAdd: false,
                  canRemove: true,
                }
              : library
          )
        );
      } catch (err) {
        setLibraryPickerError(
          toFeedback(err, { fallback: "Failed to add media to library" }).title
        );
      } finally {
        setLibraryMembershipBusy(false);
      }
    },
    [libraryMembershipBusy, media?.id]
  );

  const handleRemoveFromLibrary = useCallback(
    async (libraryId: string) => {
      if (!media?.id || libraryMembershipBusy) {
        return;
      }
      setLibraryMembershipBusy(true);
      setLibraryPickerError(null);
      try {
        const response = await apiFetch<{ data: { hard_deleted: boolean } }>(
          `/api/media/${media.id}?library_id=${encodeURIComponent(libraryId)}`,
          {
            method: "DELETE",
          }
        );
        if (response.data.hard_deleted) {
          router.push("/libraries");
          return;
        }
        setLibraryPickerLibraries((current) =>
          current.map((library) =>
            library.id === libraryId
              ? {
                  ...library,
                  isInLibrary: false,
                  canAdd: true,
                  canRemove: false,
                }
              : library
          )
        );
      } catch (err) {
        setLibraryPickerError(
          toFeedback(err, { fallback: "Failed to remove media from library" }).title
        );
      } finally {
        setLibraryMembershipBusy(false);
      }
    },
    [libraryMembershipBusy, media?.id, router]
  );

  const handleDeleteDocument = useCallback(async () => {
    if (!media?.id || documentDeleteBusy) {
      return;
    }
    if (
      !window.confirm(
        `Delete "${media.title}" from My Library and libraries you manage? This cannot be undone.`
      )
    ) {
      return;
    }

    setDocumentDeleteBusy(true);
    try {
      await apiFetch<{
        data: {
          status: "deleted" | "removed" | "hidden";
          hard_deleted: boolean;
          removed_from_library_ids?: string[];
          hidden_for_viewer?: boolean;
          remaining_reference_count?: number;
        };
      }>(`/api/media/${media.id}`, { method: "DELETE" });
      router.push("/libraries");
    } catch (err) {
      feedback.show({
        ...toFeedback(err, { fallback: "Failed to delete document" }),
      });
    } finally {
      setDocumentDeleteBusy(false);
    }
  }, [documentDeleteBusy, feedback, media?.id, media?.title, router]);

  const handleRetryProcessing = useCallback(async () => {
    if (!media?.id || retryProcessingBusy || !media.capabilities?.can_retry) {
      return;
    }

    setRetryProcessingBusy(true);
    try {
      await apiFetch(`/api/media/${media.id}/retry`, { method: "POST" });
      setFragments([]);
      setEpubSections(null);
      setEpubToc(null);
      setActiveSectionId(null);
      setEpubError("processing");
      setMedia((prev) =>
        prev && prev.id === media.id
          ? {
              ...prev,
              processing_status: "extracting",
              failure_stage: null,
              last_error_code: null,
              capabilities: prev.capabilities
                ? {
                    ...prev.capabilities,
                    can_read: false,
                    can_highlight: false,
                    can_quote: false,
                    can_search: false,
                    can_retry: false,
                  }
                : prev.capabilities,
            }
          : prev
      );
      feedback.show({ severity: "success", title: "Processing retry started." });
    } catch (err) {
      feedback.show({
        ...toFeedback(err, { fallback: "Failed to retry processing" }),
      });
    } finally {
      setRetryProcessingBusy(false);
    }
  }, [feedback, media?.capabilities?.can_retry, media?.id, retryProcessingBusy]);

  const handleRefreshSource = useCallback(async () => {
    if (!media?.id || refreshSourceBusy || !media.capabilities?.can_refresh_source) {
      return;
    }

    setRefreshSourceBusy(true);
    try {
      await apiFetch(`/api/media/${media.id}/refresh`, { method: "POST" });
      setFragments([]);
      setEpubSections(null);
      setEpubToc(null);
      setActiveSectionId(null);
      setEpubError("processing");
      setMedia((prev) =>
        prev && prev.id === media.id
          ? {
              ...prev,
              processing_status: "extracting",
              failure_stage: null,
              last_error_code: null,
              capabilities: prev.capabilities
                ? {
                    ...prev.capabilities,
                    can_read: false,
                    can_highlight: false,
                    can_quote: false,
                    can_search: false,
                    can_retry: false,
                    can_refresh_source: false,
                  }
                : prev.capabilities,
            }
          : prev
      );
      feedback.show({ severity: "success", title: "Source refresh started." });
    } catch (err) {
      feedback.show({
        ...toFeedback(err, { fallback: "Failed to refresh source" }),
      });
    } finally {
      setRefreshSourceBusy(false);
    }
  }, [
    feedback,
    media?.capabilities?.can_refresh_source,
    media?.id,
    refreshSourceBusy,
  ]);

  const handleContentClick = useCallback(
    (e: React.MouseEvent) => {
      handleMediaContentClick(e);
    },
    [handleMediaContentClick]
  );

  const handlePdfHighlightTap = useCallback(
    (highlightId: string, _anchorRect: DOMRect) => {
      focusHighlight(highlightId);
    },
    [focusHighlight]
  );

  const handleDocumentScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      paneMobileChrome?.onDocumentScroll({
        scrollTop: event.currentTarget.scrollTop,
        scrollHeight: event.currentTarget.scrollHeight,
        clientHeight: event.currentTarget.clientHeight,
      });
    },
    [paneMobileChrome]
  );

  const handleQuoteToChat = useCallback(
    (color: HighlightColor) => {
      if (!media || !activeContent) {
        return;
      }
      const activeSelection = selection ?? selectionSnapshotRef.current;
      if (!activeSelection || activeSelection.fragmentId !== activeContent.fragmentId) {
        feedback.show({
          severity: "warning",
          title: "Selection changed. Select text again.",
        });
        clearRetainedSelection(false);
        return;
      }

      const exact = activeSelection.selectedText.trim();
      if (!exact) {
        return;
      }

      const chars = [...activeContent.canonicalText];
      const prefix = chars
        .slice(
          Math.max(0, activeSelection.startOffset - READER_SELECTION_CONTEXT_CP),
          activeSelection.startOffset
        )
        .join("");
      const suffix = chars
        .slice(
          activeSelection.endOffset,
          Math.min(chars.length, activeSelection.endOffset + READER_SELECTION_CONTEXT_CP)
        )
        .join("");

      openReaderAssistant([
        {
          kind: "reader_selection",
          client_context_id: crypto.randomUUID(),
          media_id: media.id,
          media_kind: media.kind,
          media_title: media.title,
          exact,
          ...(prefix ? { prefix } : {}),
          ...(suffix ? { suffix } : {}),
          preview: exact.slice(0, 120),
          locator: {
            type: "reader_text_offsets",
            media_kind: media.kind,
            ...(isEpub && activeEpubSection?.section_id
              ? { section_id: activeEpubSection.section_id }
              : {}),
            fragment_id: activeSelection.fragmentId,
            start_offset: activeSelection.startOffset,
            end_offset: activeSelection.endOffset,
            text_quote_selector: {
              exact,
              ...(prefix ? { prefix } : {}),
              ...(suffix ? { suffix } : {}),
            },
          },
          color,
        },
      ]);
      clearRetainedSelection(true);
    },
    [
      activeContent,
      clearRetainedSelection,
      feedback,
      media,
      openReaderAssistant,
      selection,
      isEpub,
      activeEpubSection?.section_id,
    ]
  );

  const handlePdfAskSelection = useCallback(
    (selectionQuote: PdfReaderSelectionQuote) => {
      if (!media) {
        return;
      }
      openReaderAssistant([
        {
          ...selectionQuote,
          media_kind: media.kind,
          media_title: media.title,
        },
      ]);
    },
    [media, openReaderAssistant]
  );

  const handleReaderAssistantConversationAvailable = useCallback(
    (conversationId: string) => {
      setReaderAssistantState((current) =>
        current
          ? {
              ...current,
              conversationId,
            }
          : current
      );
    },
    []
  );

  const handleOpenReaderAssistantConversation = useCallback(
    (conversationId: string) => {
      if (isMobileViewport) {
        setReaderAssistantState(null);
      }
      const route = `/conversations/${conversationId}`;
      if (!requestOpenInAppPane(route, { titleHint: "Chat" })) {
        router.push(route);
      }
    },
    [isMobileViewport, router]
  );

  const handleReaderAssistantScopeChange = useCallback((conversationScope: ConversationScope) => {
    setReaderAssistantState((current) =>
      current
        ? {
            ...current,
            conversationId: null,
            conversationScope,
          }
        : current
    );
  }, []);

  const handleExistingHighlightSendToChat = useCallback(
    (highlightId: string) => {
      openReaderAssistant([buildHighlightChatContext(highlightId)]);
    },
    [buildHighlightChatContext, openReaderAssistant]
  );

  useEffect(() => {
    const handleAskShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.key.toLowerCase() !== "g") {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      event.preventDefault();
      if (event.shiftKey) {
        openReaderAssistant([]);
        return;
      }
      handleQuoteToChat("yellow");
    };

    document.addEventListener("keydown", handleAskShortcut);
    return () => document.removeEventListener("keydown", handleAskShortcut);
  }, [handleQuoteToChat, openReaderAssistant]);

  const isReflowableReader = canRead && !isPdf;
  const mediaHeaderMeta = (
    <div className={styles.metadata}>
      <span className={styles.kind}>{media?.kind}</span>
      <ContributorCreditList
        credits={media?.contributors}
        className={styles.authorMeta}
        maxVisible={2}
        showRole
      />
      {media?.canonical_source_url ? (
        <a
          href={media.canonical_source_url}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.sourceLink}
        >
          View Source ↗
        </a>
      ) : null}
    </div>
  );

  const mediaHeaderOptions = mediaResourceOptions({
    media,
    canManageLibraries: Boolean(media),
    retryBusy: retryProcessingBusy,
    refreshBusy: refreshSourceBusy,
    deleteBusy: documentDeleteBusy,
    onRetry: media?.capabilities?.can_retry
      ? () => {
          void handleRetryProcessing();
      }
      : undefined,
    onRefreshSource: media?.capabilities?.can_refresh_source
      ? () => {
          void handleRefreshSource();
        }
      : undefined,
    onOpenChat: media
      ? () => {
          openReaderAssistant([]);
        }
      : undefined,
    onManageLibraries: ({ triggerEl }) => {
      setLibraryPanelAnchorEl(triggerEl);
      setLibraryPanelOpen(true);
      void loadLibraryPickerLibraries();
    },
    onDelete: media?.capabilities?.can_delete
      ? () => {
          void handleDeleteDocument();
        }
      : undefined,
  });
  const mediaReaderOptions: ActionMenuOption[] = [];

  if (isEpub && canRead && (hasEpubToc || tocWarning)) {
    mediaReaderOptions.push({
      id: "toggle-epub-toc",
      label: epubTocExpanded ? "Hide table of contents" : "Show table of contents",
      onSelect: () => setEpubTocExpanded((value) => !value),
    });
  }

  if (isReflowableReader) {
    mediaReaderOptions.push({
      id: "reader-theme-light",
      label:
        readerProfile.theme === "light" ? "Light theme (current)" : "Light theme",
      disabled: readerProfile.theme === "light",
      onSelect: () => updateTheme("light"),
    });
    mediaReaderOptions.push({
      id: "reader-theme-dark",
      label: readerProfile.theme === "dark" ? "Dark theme (current)" : "Dark theme",
      disabled: readerProfile.theme === "dark",
      onSelect: () => updateTheme("dark"),
    });
  }

  const mediaDangerOptionIndex = mediaHeaderOptions.findIndex(
    (option) => option.tone === "danger"
  );
  if (mediaDangerOptionIndex === -1) {
    mediaHeaderOptions.push(...mediaReaderOptions);
  } else {
    mediaHeaderOptions.splice(mediaDangerOptionIndex, 0, ...mediaReaderOptions);
  }

  const mediaToolbar =
    isPdf && canRead && pdfControlsState ? (
      <div className={styles.mediaToolbar} role="toolbar" aria-label="PDF controls">
        <div className={styles.mediaToolbarRow}>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            onClick={() => pdfControlsRef.current?.goToPreviousPage()}
            disabled={!pdfControlsState.canGoPrev}
            aria-label="Previous page"
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </Button>
          <span
            className={styles.mediaToolbarStatus}
            aria-label={`Page ${pdfControlsState.pageNumber} of ${pdfControlsState.numPages || 0}`}
          >
            {pdfControlsState.pageNumber} / {pdfControlsState.numPages || 0}
          </span>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            onClick={() => pdfControlsRef.current?.goToNextPage()}
            disabled={!pdfControlsState.canGoNext}
            aria-label="Next page"
          >
            <ChevronRight size={16} aria-hidden="true" />
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onMouseDown={(event) => {
              event.preventDefault();
              pdfControlsRef.current?.captureSelectionSnapshot();
            }}
            onClick={() => pdfControlsRef.current?.createHighlight("yellow")}
            disabled={!pdfControlsState.canCreateHighlight || pdfControlsState.isCreating}
            aria-label="Highlight selection"
            data-create-attempts={pdfControlsState.createTelemetry.attempts}
            data-create-post-requests={pdfControlsState.createTelemetry.postRequests}
            data-create-patch-requests={pdfControlsState.createTelemetry.patchRequests}
            data-create-successes={pdfControlsState.createTelemetry.successes}
            data-create-errors={pdfControlsState.createTelemetry.errors}
            data-create-last-outcome={pdfControlsState.createTelemetry.lastOutcome}
            data-page-render-epoch={pdfControlsState.pageRenderEpoch}
            data-selection-popover-ignore-outside="true"
          >
            Highlight
          </Button>
          <ActionMenu
            label="More actions"
            options={[
              {
                id: "zoom-out",
                label: "Zoom out",
                disabled: !pdfControlsState.canZoomOut,
                onSelect: () => pdfControlsRef.current?.zoomOut(),
              },
              {
                id: "zoom-in",
                label: "Zoom in",
                disabled: !pdfControlsState.canZoomIn,
                onSelect: () => pdfControlsRef.current?.zoomIn(),
              },
            ]}
          />
        </div>
      </div>
    ) : isEpub && canRead ? (
      <div className={styles.mediaToolbar} role="toolbar" aria-label="EPUB controls">
        <div className={styles.mediaToolbarRow}>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            onClick={() => {
              if (prevSection) {
                navigateToSection(prevSection.section_id);
              }
            }}
            disabled={!prevSection}
            aria-label="Previous section"
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </Button>
          {activeSectionPosition >= 0 && epubSections ? (
            <span
              className={styles.mediaToolbarStatus}
              aria-label={`Section ${activeSectionPosition + 1} of ${epubSections.length}`}
            >
              {activeSectionPosition + 1} / {epubSections.length}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            onClick={() => {
              if (nextSection) {
                navigateToSection(nextSection.section_id);
              }
            }}
            disabled={!nextSection}
            aria-label="Next section"
          >
            <ChevronRight size={16} aria-hidden="true" />
          </Button>
        </div>
        {epubSections ? (
          <div className={styles.mediaToolbarRow}>
            <Select
              size="sm"
              value={activeSectionId ?? ""}
              onChange={(event) => {
                if (event.target.value) {
                  navigateToSection(event.target.value);
                }
              }}
              aria-label="Select section"
            >
              {epubSections.map((section) => (
                <option key={section.section_id} value={section.section_id}>
                  {section.label}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>
    ) : null;

  // ==========================================================================
  // Chrome override — push toolbar/options/meta/actions into PaneShell
  // ==========================================================================

  usePaneChromeOverride({
    toolbar: mediaToolbar,
    options: mediaHeaderOptions,
    meta: mediaHeaderMeta,
  });

  // Close the highlights inspector when highlights become unavailable (focus
  // mode flip, media swap, etc.). The gutter itself stays mounted but the
  // overlay should not strand on top of an unrelated reader.
  useEffect(() => {
    if (isHighlightsInspectorOpen && !showHighlightsPane) {
      setHighlightsInspectorOpen(false);
    }
  }, [isHighlightsInspectorOpen, showHighlightsPane]);

  useEffect(() => {
    setVideoSeekTargetMs(null);
  }, [media?.kind, playbackSource?.embed_url, playbackSource?.kind, playbackSource?.source_url]);

  const handleTranscriptSeek = useCallback(
    (timestampMs: number | null | undefined) => {
      if (media?.kind === "video") {
        setVideoSeekTargetMs(timestampMs ?? null);
        return;
      }

      seekToMs(timestampMs);
      play();
    },
    [media?.kind, play, seekToMs]
  );

  const handleReaderSourceActivate = useCallback(
    (target: ReaderSourceTarget) => {
      if (target.media_id !== id) {
        const route = target.href || `/media/${target.media_id}`;
        if (!requestOpenInAppPane(route, { titleHint: target.label ?? "Source" })) {
          router.push(route);
        }
        return;
      }

      setReaderSourceTarget(target);
      if (isMobileViewport) {
        setReaderAssistantState(null);
      }

      if (target.href === `/media/${id}` || target.href?.startsWith(`/media/${id}?`)) {
        router.push(target.href);
        return;
      }

      const locator = target.locator;
      if (typeof locator !== "object" || locator === null || Array.isArray(locator)) {
        feedback.show({ severity: "warning", title: "Source location unavailable." });
        return;
      }

      const params = new URLSearchParams(searchParams.toString());
      params.delete("highlight");
      if (target.evidence_span_id) {
        params.set("evidence", target.evidence_span_id);
      } else {
        params.delete("evidence");
      }

      const type = locator.type;
      if (type === "pdf_page_geometry" || type === "pdf_text_quote") {
        const pageNumber = locator.page_number;
        if (typeof pageNumber !== "number" || !Number.isInteger(pageNumber) || pageNumber < 1) {
          feedback.show({ severity: "warning", title: "Source location unavailable." });
          return;
        }
        params.set("page", String(pageNumber));
        router.push(`/media/${id}?${params.toString()}`);
        return;
      }

      if (type === "epub_fragment_offsets" || type === "reader_text_offsets") {
        const sectionId =
          typeof locator.section_id === "string"
            ? locator.section_id
            : activeEpubSection?.section_id ?? null;
        const fragmentId =
          typeof locator.fragment_id === "string" ? locator.fragment_id : null;
        if (sectionId && isEpub) {
          router.push(
            buildEpubLocationHref(id, sectionId, {
              fragmentId: fragmentId ?? undefined,
            })
          );
          return;
        }
        if (fragmentId) {
          params.set("fragment", fragmentId);
          router.push(`/media/${id}?${params.toString()}`);
          return;
        }
        feedback.show({ severity: "warning", title: "Source location unavailable." });
        return;
      }

      if (type === "transcript_time_range") {
        const timestampMs = locator.t_start_ms;
        if (typeof timestampMs !== "number" || !Number.isInteger(timestampMs) || timestampMs < 0) {
          feedback.show({ severity: "warning", title: "Source location unavailable." });
          return;
        }
        params.set("t_start_ms", String(timestampMs));
        router.push(`/media/${id}?${params.toString()}`);
        handleTranscriptSeek(timestampMs);
        return;
      }

      feedback.show({ severity: "warning", title: "Source location unavailable." });
    },
    [
      activeEpubSection?.section_id,
      feedback,
      handleTranscriptSeek,
      id,
      isEpub,
      isMobileViewport,
      router,
      searchParams,
    ]
  );

  useEffect(() => {
    if (!paneMobileChrome || !isMobileViewport) {
      return;
    }
    const releaseLocks: Array<() => void> = [];
    if (isHighlightsInspectorOpen) {
      releaseLocks.push(paneMobileChrome.acquireVisibleLock("highlights-inspector"));
    }
    if (libraryPanelOpen) {
      releaseLocks.push(paneMobileChrome.acquireVisibleLock("library-picker"));
    }
    if (selection && !focusState.editingBounds) {
      releaseLocks.push(paneMobileChrome.acquireVisibleLock("text-selection"));
    }
    return () => {
      for (const releaseLock of releaseLocks) {
        releaseLock();
      }
    };
  }, [
    isHighlightsInspectorOpen,
    libraryPanelOpen,
    focusState.editingBounds,
    isMobileViewport,
    paneMobileChrome,
    selection,
  ]);

  useEffect(() => {
    if (media) {
      return;
    }
    setLibraryPanelOpen(false);
    setLibraryPanelAnchorEl(null);
  }, [media]);

  useEffect(() => {
    if (!media || !isTranscriptMedia) {
      seededPodcastTrackRef.current = null;
      return;
    }
    if (media.kind !== "podcast_episode" || playbackSource?.kind !== "external_audio") {
      seededPodcastTrackRef.current = null;
      return;
    }

    const listeningState = media.listening_state;
    const seededTrackKey = JSON.stringify({
      mediaId: media.id,
      streamUrl: playbackSource.stream_url,
      sourceUrl: playbackSource.source_url,
      podcastTitle: media.podcast_title ?? null,
      imageUrl: media.podcast_image_url ?? null,
      chapters: media.chapters ?? [],
      positionMs: listeningState?.position_ms ?? null,
      playbackSpeed: listeningState?.playback_speed ?? media.subscription_default_playback_speed ?? null,
    });
    if (seededPodcastTrackRef.current === seededTrackKey) {
      return;
    }
    seededPodcastTrackRef.current = seededTrackKey;

    const trackOptions: {
      autoplay: false;
      seek_seconds?: number;
      playback_rate?: number;
    } = { autoplay: false };

    if (listeningState) {
      trackOptions.seek_seconds = Math.max(0, Math.floor(listeningState.position_ms / 1000));
      trackOptions.playback_rate = listeningState.playback_speed;
    } else if (media.subscription_default_playback_speed != null) {
      trackOptions.playback_rate = media.subscription_default_playback_speed;
    }

    setTrack(
      {
        media_id: media.id,
        title: media.title,
        stream_url: playbackSource.stream_url,
        source_url: playbackSource.source_url,
        podcast_title: media.podcast_title ?? undefined,
        image_url: media.podcast_image_url ?? undefined,
        chapters: normalizeTranscriptChapters(media.chapters),
      },
      trackOptions
    );

    if (!listeningState || listeningState.position_ms <= 0) {
      return;
    }
    if (resumeNoticeMediaIdRef.current === media.id) {
      return;
    }

    resumeNoticeMediaIdRef.current = media.id;
    feedback.show({
      severity: "info",
      title: `Resuming from ${formatResumeTime(listeningState.position_ms)}`,
    });
  }, [
    isTranscriptMedia,
    media,
    media?.chapters,
    media?.id,
    media?.kind,
    media?.listening_state,
    media?.podcast_image_url,
    media?.podcast_title,
    media?.subscription_default_playback_speed,
    media?.title,
    playbackSource?.kind,
    playbackSource?.source_url,
    playbackSource?.stream_url,
    setTrack,
    feedback,
  ]);

  const handleJumpToHighlight = useCallback(
    (highlightId: string) => {
      const fragmentMatch = highlights.find((h) => h.id === highlightId);
      if (fragmentMatch) {
        dispatchReaderPulse({
          mediaId: id,
          locator: {
            type: isEpub ? "epub_fragment_offsets" : "reader_text_offsets",
            fragment_id: fragmentMatch.anchor.fragment_id,
            start_offset: fragmentMatch.anchor.start_offset,
            end_offset: fragmentMatch.anchor.end_offset,
          },
          snippet: fragmentMatch.exact,
        });
        return;
      }
      const pdfMatch = pdfDocumentHighlights.find((h) => h.id === highlightId);
      if (pdfMatch) {
        dispatchReaderPulse({
          mediaId: id,
          locator: {
            type: "pdf_page_geometry",
            page_number: pdfMatch.anchor.page_number,
            quads: pdfMatch.anchor.quads,
          },
          snippet: pdfMatch.exact,
        });
      }
    },
    [highlights, id, isEpub, pdfDocumentHighlights],
  );

  const transcriptGutterHighlights = useMemo<
    ReaderGutterTranscriptHighlight[]
  >(() => {
    if (!isTranscriptMedia) return [];
    const fragmentStartByid = new Map<string, number>();
    for (const fragment of fragments) {
      if (fragment.t_start_ms != null && fragment.t_start_ms >= 0) {
        fragmentStartByid.set(fragment.id, fragment.t_start_ms);
      }
    }
    const out: ReaderGutterTranscriptHighlight[] = [];
    for (const highlight of highlights) {
      const startMs = fragmentStartByid.get(highlight.anchor.fragment_id);
      if (startMs == null) continue;
      out.push({ highlight, fragmentStartMs: startMs });
    }
    return out;
  }, [fragments, highlights, isTranscriptMedia]);

  // ==========================================================================
  // Render
  // ==========================================================================

  if (loading) {
    return <FeedbackNotice severity="info" title="Loading media..." />;
  }

  if (error || !media) {
    return (
      <div className={styles.errorContainer}>
        <FeedbackNotice
          feedback={error ?? { severity: "error", title: "Media not found" }}
        />
      </div>
    );
  }

  if (isEpub && epubError === "processing" && !canRead && media.processing_status !== "failed") {
    return (
      <div className={styles.content}>
        <div className={styles.notReady}>
          <p>This EPUB is still being processed.</p>
          <p>Status: {media.processing_status}</p>
        </div>
      </div>
    );
  }

  const readerAssistantScopeOptions: ReaderAssistantScopeOption[] = [
    {
      id: "document",
      label: "Document",
      scope: buildMediaConversationScope(),
    },
    {
      id: "new",
      label: "New chat",
      scope: { type: "general" },
    },
    ...libraryPickerLibraries
      .filter((library) => library.isInLibrary)
      .map((library) => ({
        id: `library:${library.id}`,
        label: library.name,
        scope: {
          type: "library" as const,
          library_id: library.id,
          title: library.name,
          library_name: library.name,
        },
      })),
  ];

  const transcriptDurationMs = media.listening_state?.duration_ms ?? 0;

  const highlightsInspectorBody = (
    <MediaHighlightsPaneBody
      isPdf={isPdf}
      isEpub={isEpub}
      fragmentHighlights={highlights}
      pdfPageHighlights={pdfHighlightsPaneState.highlights}
      pdfActivePage={pdfHighlightsPaneState.activePage}
      focusedId={focusState.focusedId}
      onFocusHighlight={focusHighlight}
      canSendToChat={Boolean(media.capabilities?.can_quote)}
      onSendToChat={handleExistingHighlightSendToChat}
      onColorChange={handleColorChange}
      onDelete={handleDelete}
      onStartEditBounds={startEditBounds}
      onCancelEditBounds={cancelEditBounds}
      isEditingBounds={focusState.editingBounds}
      onNoteSave={handleNoteSave}
      onNoteDelete={handleNoteDelete}
      onOpenConversation={handleOpenConversation}
      onJumpToHighlight={handleJumpToHighlight}
    />
  );

  const isReaderChatOverlayOpen =
    !isMobileViewport && readerAssistantState !== null;
  const readerChatOverlayContent =
    readerAssistantState ? (
      <ReaderAssistantPane
        contexts={readerAssistantState.contexts}
        conversationId={readerAssistantState.conversationId}
        conversationScope={readerAssistantState.conversationScope}
        targetLabel={readerAssistantState.targetLabel}
        scopeOptions={readerAssistantScopeOptions}
        onScopeChange={handleReaderAssistantScopeChange}
        onConversationAvailable={handleReaderAssistantConversationAvailable}
        onOpenFullChat={handleOpenReaderAssistantConversation}
        onReaderSourceActivate={handleReaderSourceActivate}
        onClose={() => setReaderAssistantState(null)}
      />
    ) : null;
  const transcriptPaneBody = !canRead ? (
    <TranscriptStatePanel
      mediaId={media.id}
      transcriptState={transcriptState}
      transcriptCoverage={transcriptCoverage}
      onTranscriptStateChange={handleTranscriptStateChange}
    />
  ) : (
    <TranscriptContentPanel
      transcriptState={transcriptState}
      transcriptCoverage={transcriptCoverage}
      chapters={media.chapters ?? []}
      fragments={fragments}
      activeFragment={activeTranscriptFragment}
      renderedHtml={renderedHtml}
      contentRef={contentRef}
      onSegmentSelect={handleTranscriptSegmentSelect}
      onSeek={handleTranscriptSeek}
      onContentClick={handleContentClick}
    />
  );

  return (
    <>
      <LibraryMembershipPanel
        open={libraryPanelOpen}
        title="Libraries"
        anchorEl={libraryPanelAnchorEl}
        libraries={libraryPickerLibraries}
        loading={libraryPickerLoading}
        busy={libraryMembershipBusy}
        error={libraryPickerError}
        emptyMessage="No non-default libraries available."
        onClose={() => setLibraryPanelOpen(false)}
        onAddToLibrary={(libraryId) => {
          void handleAddToLibrary(libraryId);
        }}
        onRemoveFromLibrary={(libraryId) => {
          void handleRemoveFromLibrary(libraryId);
        }}
      />
      <div
        className={styles.splitLayout}
        data-focus-mode={focusModeForRoot}
        data-chrome-revealed={chromeRevealed ? "true" : undefined}
      >
        <div className={styles.readerColumn}>
          {!isPdf && isMismatchDisabled && (
            <div className={styles.mismatchBanner}>
              Highlights disabled due to content mismatch. Try reloading.
            </div>
          )}
          {focusModeEnabled && (
            <div className={styles.focusModeBanner}>
              <Pill tone="info">
                Focus mode enabled: highlights pane hidden.
              </Pill>
            </div>
          )}
          {media.retrieval_status && media.retrieval_status !== "ready" && canRead ? (
            <div className={styles.retrievalBanner} data-testid="retrieval-readiness">
              <Pill tone={media.retrieval_status === "failed" ? "danger" : "warning"}>
                Search index: {media.retrieval_status.replaceAll("_", " ")}
              </Pill>
              {media.retrieval_status_reason ? (
                <span>{media.retrieval_status_reason}</span>
              ) : null}
            </div>
          ) : null}

          {isTranscriptMedia ? (
            <div className={styles.readerWithGutter}>
              <div
                ref={setReaderScrollContainer}
                className={styles.documentViewport}
                data-testid="document-viewport"
                data-pane-content="true"
                onScroll={handleDocumentScroll}
              >
                <div className={styles.transcriptPane}>
                  <TranscriptPlaybackPanel
                    mediaId={media.id}
                    mediaKind={media.kind === "video" ? "video" : "podcast_episode"}
                    playbackSource={playbackSource}
                    canonicalSourceUrl={media.canonical_source_url}
                    chapters={media.chapters ?? []}
                    descriptionHtml={media.description_html ?? null}
                    descriptionText={media.description_text ?? null}
                    videoSeekTargetMs={
                      media.kind === "video" ? videoSeekTargetMs ?? activeRequestedStartMs : null
                    }
                    onSeek={handleTranscriptSeek}
                  />
                  {transcriptPaneBody}
                </div>
              </div>
              {showHighlightsPane ? (
                <ReaderGutter
                  mediaId={id}
                  mediaKind="transcript"
                  transcriptHighlights={transcriptGutterHighlights}
                  durationMs={transcriptDurationMs}
                  scrollContainer={readerScrollContainer}
                  onExpand={() => setHighlightsInspectorOpen(true)}
                />
              ) : null}
            </div>
          ) : !canRead ? (
            <div className={styles.notReady}>
              {media.processing_status === "failed" ? (
                <>
                  {isPdf && media.last_error_code === "E_PDF_PASSWORD_REQUIRED" ? (
                    <p>This PDF is password-protected and cannot be opened in v1.</p>
                  ) : (
                    <p>This media cannot be opened right now.</p>
                  )}
                  {media.last_error_code && <p>Error: {media.last_error_code}</p>}
                  {media.capabilities?.can_retry ? (
                    <Button
                      variant="primary"
                      size="md"
                      leadingIcon={<RefreshCw size={15} aria-hidden="true" />}
                      onClick={() => {
                        void handleRetryProcessing();
                      }}
                      disabled={retryProcessingBusy}
                    >
                      {retryProcessingBusy ? "Retrying..." : "Retry processing"}
                    </Button>
                  ) : null}
                </>
              ) : (
                <>
                  <p>This media is still being processed.</p>
                  <p>Status: {media.processing_status}</p>
                </>
              )}
            </div>
          ) : isPdf ? (
            readerResumeStateLoading ? (
              <div className={styles.notReady}>
                <p>Loading reader state...</p>
              </div>
            ) : (
              <div className={styles.readerWithGutter}>
                <PdfReader
                  key={`${id}:${activeRequestedPdfPageNumber ?? resolvedPdfPageNumber ?? "resume"}`}
                  mediaId={id}
                  contentRef={pdfContentRef}
                  focusedHighlightId={focusState.focusedId}
                  editingHighlightId={focusState.editingBounds ? focusState.focusedId : null}
                  highlightRefreshToken={pdfRefreshToken}
                  onPageHighlightsChange={handlePdfPageHighlightsChange}
                  onHighlightTap={handlePdfHighlightTap}
                  temporaryHighlight={temporaryPdfHighlight}
                  onAskSelection={media.capabilities?.can_quote ? handlePdfAskSelection : undefined}
                  onControlsStateChange={setPdfControlsState}
                  onControlsReady={(controls) => {
                    pdfControlsRef.current = controls;
                  }}
                  startPageNumber={
                    activeRequestedPdfPageNumber ??
                    resolvedPdfPageNumber ??
                    pdfReaderResumeState?.page ??
                    undefined
                  }
                  startPageProgression={
                    activeRequestedPdfPageNumber || resolvedPdfPageNumber
                      ? undefined
                      : pdfReaderResumeState?.page_progression ?? undefined
                  }
                  startZoom={pdfReaderResumeState?.zoom ?? undefined}
                  onResumeStateChange={saveReaderResumeState}
                />
                {showHighlightsPane ? (
                  <ReaderGutter
                    mediaId={id}
                    mediaKind="pdf"
                    pdfHighlights={pdfDocumentHighlights}
                    totalPages={pdfControlsState?.numPages ?? 0}
                    scrollContainer={null}
                    onExpand={() => setHighlightsInspectorOpen(true)}
                  />
                ) : null}
              </div>
            )
          ) : isEpub ? (
            <div className={styles.readerWithGutter}>
              <div
                ref={setReaderScrollContainer}
                className={styles.documentViewport}
                data-testid="document-viewport"
                data-pane-content="true"
                onScroll={handleDocumentScroll}
              >
                <div
                  ref={readerRootRef}
                  className={readerSurfaceClassName}
                  style={readerSurfaceStyle}
                  data-focus-mode={focusModeForRoot}
                  data-hyphenation={hyphenationForRoot}
                >
                  <div className={styles.readerContentInner}>
                    <EpubContentPane
                      mediaId={id}
                      sections={epubSections}
                      activeChapter={activeChapter}
                      activeSectionId={activeSectionId}
                      chapterLoading={chapterLoading}
                      epubError={epubError}
                      toc={epubToc}
                      tocWarning={tocWarning}
                      tocExpanded={epubTocExpanded}
                      contentRef={contentRef}
                      renderedHtml={renderedHtml}
                      onContentClick={handleContentClick}
                      onNavigate={navigateToSection}
                    />
                  </div>
                </div>
              </div>
              {showHighlightsPane ? (
                <ReaderGutter
                  mediaId={id}
                  mediaKind="epub"
                  highlights={highlights}
                  scrollContainer={readerScrollContainer}
                  onExpand={() => setHighlightsInspectorOpen(true)}
                />
              ) : null}
            </div>
          ) : fragments.length === 0 ? (
            <div className={styles.empty}>
              <p>No content available for this media.</p>
            </div>
          ) : (
            <div className={styles.readerWithGutter}>
              <div
                ref={setReaderScrollContainer}
                className={styles.documentViewport}
                data-testid="document-viewport"
                data-pane-content="true"
                onScroll={handleDocumentScroll}
              >
                <div
                  ref={readerRootRef}
                  className={readerSurfaceClassName}
                  style={readerSurfaceStyle}
                  data-focus-mode={focusModeForRoot}
                  data-hyphenation={hyphenationForRoot}
                >
                  <div className={styles.readerContentInner}>
                    <div
                      ref={contentRef}
                      className={styles.fragments}
                      onClick={handleContentClick}
                    >
                      <HtmlRenderer
                        htmlSanitized={renderedHtml}
                        className={styles.fragment}
                        mediaId={id}
                      />
                    </div>
                  </div>
                </div>
              </div>
              {showHighlightsPane ? (
                <ReaderGutter
                  mediaId={id}
                  mediaKind="web"
                  highlights={highlights}
                  scrollContainer={readerScrollContainer}
                  onExpand={() => setHighlightsInspectorOpen(true)}
                />
              ) : null}
            </div>
          )}
        </div>

        <ReaderChatOverlay
          open={isReaderChatOverlayOpen}
          onClose={() => setReaderAssistantState(null)}
        >
          {readerChatOverlayContent}
        </ReaderChatOverlay>

        {showHighlightsPane ? (
          <HighlightsInspectorOverlay
            open={isHighlightsInspectorOpen}
            onClose={() => setHighlightsInspectorOpen(false)}
          >
            {highlightsInspectorBody}
          </HighlightsInspectorOverlay>
        ) : null}
      </div>

      {isMobileViewport && readerAssistantState ? (
        <QuoteChatSheet
          contexts={readerAssistantState.contexts}
          conversationId={readerAssistantState.conversationId}
          conversationScope={readerAssistantState.conversationScope}
          targetLabel={readerAssistantState.targetLabel}
          onClose={() => setReaderAssistantState(null)}
          onConversationCreated={handleReaderAssistantConversationAvailable}
          onOpenFullChat={handleOpenReaderAssistantConversation}
          onReaderSourceActivate={handleReaderSourceActivate}
        />
      ) : null}

      {!isPdf && selection && !focusState.editingBounds && contentRef.current && (
        <SelectionPopover
          selectionRect={selection.rect}
          selectionLineRects={selection.lineRects}
          containerRef={contentRef}
          onCreateHighlight={handleCreateHighlight}
          onAsk={media.capabilities?.can_quote ? handleQuoteToChat : undefined}
          onDismiss={handleDismissPopover}
          isCreating={isCreating}
        />
      )}
    </>
  );
}
