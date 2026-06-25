import { describe, expect, it } from "vitest";
import { resolveInitialEpubRestoreRequest } from "./epubRestore";
import type { ReaderNavigationSection } from "@/lib/media/readerNavigation";

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
  char_count: 100,
};

describe("resolveInitialEpubRestoreRequest", () => {
  it("preserves anchors resolved from requested URL sections", () => {
    expect(
      resolveInitialEpubRestoreRequest({
        requestedSectionId: SECTION.section_id,
        resumeState: null,
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
});
