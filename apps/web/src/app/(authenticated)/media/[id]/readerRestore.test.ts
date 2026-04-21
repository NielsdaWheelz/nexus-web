import { describe, expect, it } from "vitest";
import type { EpubNavigationSection } from "@/lib/media/epubReader";
import type { EpubReaderResumeState } from "@/lib/reader";
import {
  buildInternalLinkRestoreRequest,
  buildManualSectionRestoreRequest,
  resolveInitialEpubRestoreRequest,
} from "./readerRestore";

const SECTIONS: EpubNavigationSection[] = [
  {
    section_id: "chapter-1",
    label: "Chapter 1",
    fragment_idx: 0,
    href_path: "chapter-1.xhtml",
    anchor_id: "chapter-1-top",
    source_node_id: "toc-1",
    source: "toc",
    ordinal: 1,
    char_count: 100,
  },
  {
    section_id: "chapter-2",
    label: "Chapter 2",
    fragment_idx: 1,
    href_path: "chapter-2.xhtml",
    anchor_id: "chapter-2-top",
    source_node_id: "toc-2",
    source: "toc",
    ordinal: 2,
    char_count: 100,
  },
];

function buildResumeState(overrides: Partial<EpubReaderResumeState> = {}): EpubReaderResumeState {
  return {
    kind: "epub",
    target: {
      section_id: "chapter-2",
      href_path: "chapter-2.xhtml",
      anchor_id: "anchor-2",
      ...overrides.target,
    },
    locations: {
      text_offset: 25,
      progression: 0.25,
      total_progression: 0.75,
      position: 2,
      ...overrides.locations,
    },
    text: {
      quote: "quoted text",
      quote_prefix: "before ",
      quote_suffix: " after",
      ...overrides.text,
    },
    ...overrides,
  };
}

describe("readerRestore", () => {
  it("prefers an explicit loc section over a saved resume target in another section", () => {
    const request = resolveInitialEpubRestoreRequest({
      requestedSectionId: "chapter-1",
      resumeState: buildResumeState(),
      sections: SECTIONS,
      readerPositionBucketCp: 100,
    });

    expect(request).toEqual({
      sectionId: "chapter-1",
      anchorId: null,
      locations: {
        text_offset: null,
        progression: null,
        total_progression: null,
        position: null,
      },
      text: {
        quote: null,
        quote_prefix: null,
        quote_suffix: null,
      },
      source: "initial_url",
      allowSectionTopFallback: true,
    });
  });

  it("keeps exact saved resume data when the explicit loc resolves to the same section", () => {
    const resumeState = buildResumeState({
      target: {
        section_id: "chapter-1",
        href_path: "chapter-1.xhtml",
        anchor_id: "anchor-1",
      },
    });

    const request = resolveInitialEpubRestoreRequest({
      requestedSectionId: "chapter-1",
      resumeState,
      sections: SECTIONS,
      readerPositionBucketCp: 100,
    });

    expect(request).toEqual({
      sectionId: "chapter-1",
      anchorId: "anchor-1",
      locations: resumeState.locations,
      text: resumeState.text,
      source: "initial_url",
      allowSectionTopFallback: true,
    });
  });

  it("falls back to total progression when the saved target section is gone", () => {
    const request = resolveInitialEpubRestoreRequest({
      requestedSectionId: null,
      resumeState: buildResumeState({
        target: {
          section_id: "missing",
          href_path: "missing.xhtml",
          anchor_id: null,
        },
        locations: {
          text_offset: null,
          progression: null,
          total_progression: 0.75,
          position: 2,
        },
      }),
      sections: SECTIONS,
      readerPositionBucketCp: 100,
    });

    expect(request?.sectionId).toBe("chapter-2");
    expect(request?.source).toBe("resume_total_progression");
  });

  it("does not allow section-top fallback for explicit anchor links", () => {
    expect(buildInternalLinkRestoreRequest("chapter-2", "note-7")).toMatchObject({
      sectionId: "chapter-2",
      anchorId: "note-7",
      source: "internal_link",
      allowSectionTopFallback: false,
    });
    expect(buildInternalLinkRestoreRequest("chapter-2", null)).toMatchObject({
      sectionId: "chapter-2",
      anchorId: null,
      source: "internal_link",
      allowSectionTopFallback: true,
    });
  });

  it("does not allow section-top fallback for anchored manual section navigation", () => {
    expect(buildManualSectionRestoreRequest("chapter-2", "note-7")).toMatchObject({
      sectionId: "chapter-2",
      anchorId: "note-7",
      source: "manual_section",
      allowSectionTopFallback: false,
    });
    expect(buildManualSectionRestoreRequest("chapter-2")).toMatchObject({
      sectionId: "chapter-2",
      anchorId: null,
      source: "manual_section",
      allowSectionTopFallback: true,
    });
  });
});
