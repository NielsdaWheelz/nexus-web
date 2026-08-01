import { describe, expect, it } from "vitest";
import { resolveInitialEpubRestoreRequest } from "./epubRestore";
import type {
  ReaderNavigationFragment,
  ReaderNavigationSection,
} from "@/lib/media/readerNavigation";

const SECTION: ReaderNavigationSection = {
  section_id: "OEBPS/chapter1.xhtml#deep-anchor",
  label: "Deep Anchor",
  ordinal: 1,
  fragment_id: "fragment-1",
  fragment_idx: 0,
  level: null,
  depth: null,
  start_offset: 0,
  end_offset: 100,
  href_path: "OEBPS/chapter1.xhtml#deep-anchor",
  href_fragment: "deep-anchor",
  anchor_id: "deep-anchor",
};

const FRAGMENT: ReaderNavigationFragment = {
  fragment_id: "fragment-1",
  fragment_idx: 0,
  char_count: 100,
};

describe("resolveInitialEpubRestoreRequest", () => {
  it("preserves anchors resolved from requested URL sections", () => {
    expect(
      resolveInitialEpubRestoreRequest({
        requestedSectionId: SECTION.section_id,
        resumeState: null,
        fragments: [FRAGMENT],
        sections: [SECTION],
        readerPositionBucketCp: 1_000,
      }),
    ).toMatchObject({
      sectionId: SECTION.section_id,
      anchorId: "deep-anchor",
      source: "initial_url",
      allowSectionTopFallback: true,
    });
  });

  it("resolves total progression to the exact heading inside a shared fragment", () => {
    const secondHeading: ReaderNavigationSection = {
      ...SECTION,
      section_id: "OEBPS/chapter1.xhtml#second-heading",
      label: "Second heading",
      ordinal: 2,
      start_offset: 40,
      end_offset: null,
      href_fragment: "second-heading",
      anchor_id: "second-heading",
    };

    expect(
      resolveInitialEpubRestoreRequest({
        requestedSectionId: null,
        resumeState: {
          kind: "epub",
          target: {
            section_id: "missing-after-source-revision",
            href_path: "OEBPS/missing.xhtml",
            anchor_id: null,
          },
          locations: {
            text_offset: null,
            progression: null,
            total_progression: 0.6,
            position: null,
          },
          text: { quote: null, quote_prefix: null, quote_suffix: null },
        },
        fragments: [FRAGMENT],
        sections: [SECTION, secondHeading],
        readerPositionBucketCp: 1_000,
      }),
    ).toMatchObject({
      sectionId: secondHeading.section_id,
      source: "resume_total_progression",
    });
  });
});
