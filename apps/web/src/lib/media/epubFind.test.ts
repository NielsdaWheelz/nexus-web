import { describe, expect, it, vi } from "vitest";
import type { ReaderNavigationSection } from "./readerNavigation";
import {
  createEpubFindSnapshot,
  decodeEpubFindResult,
  decodeEpubSectionContent,
  requestEpubFind,
  requestEpubSection,
} from "./epubFind";

const MEDIA_ID = "00000000-0000-4000-8000-000000000001";
const FIRST_FRAGMENT = "10000000-0000-4000-8000-000000000001";
const SECOND_FRAGMENT = "20000000-0000-4000-8000-000000000002";

function navigationSection(
  overrides: Partial<ReaderNavigationSection> = {},
): ReaderNavigationSection {
  return {
    section_id: "section-1",
    label: "Chapter one",
    ordinal: 0,
    fragment_id: FIRST_FRAGMENT,
    fragment_idx: 0,
    level: null,
    depth: null,
    start_offset: 0,
    end_offset: null,
    href_path: "chapter-1.xhtml",
    href_fragment: null,
    anchor_id: null,
    ...overrides,
  };
}

function readyResponse() {
  return {
    data: {
      kind: "Ready",
      source_witness_fragment_id: FIRST_FRAGMENT,
      occurrences: [
        {
          section_id: "section-1",
          section_label: "Chapter one",
          fragment_id: FIRST_FRAGMENT,
          fragment_idx: 0,
          start_offset: 1,
          end_offset: 5,
          snippet: [
            { text: "A ", emphasized: false },
            { text: "find", emphasized: true },
            { text: " result", emphasized: false },
          ],
        },
      ],
    },
  };
}

function sectionResponse() {
  return {
    data: {
      section_id: "section-1",
      label: "Chapter one",
      fragment_id: FIRST_FRAGMENT,
      fragment_idx: 0,
      href_path: "chapter-1.xhtml",
      anchor_id: null,
      source_node_id: null,
      source: "spine",
      ordinal: 0,
      prev_section_id: null,
      next_section_id: "section-2",
      html_sanitized: "<p>Find result</p>",
      canonical_text: "Find result",
      char_count: 11,
      word_count: 2,
      document_word_start: 0,
      created_at: "2026-07-29T00:00:00Z",
    },
  };
}

describe("createEpubFindSnapshot", () => {
  it("compacts navigation to ordered unique canonical fragments", () => {
    const snapshot = createEpubFindSnapshot({
      mediaId: MEDIA_ID,
      fragments: [
        { fragment_id: FIRST_FRAGMENT, fragment_idx: 0, char_count: 12 },
        { fragment_id: SECOND_FRAGMENT, fragment_idx: 1, char_count: 8 },
      ],
      navigation: [
        navigationSection(),
        navigationSection({
          section_id: "section-1-2",
          label: "Chapter one, second heading",
          ordinal: 1,
          href_fragment: "second-heading",
          anchor_id: "second-heading",
        }),
        navigationSection({
          section_id: "section-2",
          label: "Chapter two",
          ordinal: 2,
          fragment_id: SECOND_FRAGMENT,
          fragment_idx: 1,
          href_path: "chapter-2.xhtml",
        }),
      ],
    });

    expect(snapshot.sourceWitnessFragmentId).toBe(FIRST_FRAGMENT);
    expect(snapshot.fragments).toEqual([
      {
        fragmentId: FIRST_FRAGMENT,
        fragmentIdx: 0,
        activationSectionId: "section-1",
        label: "Chapter one",
        charCount: 12,
        navigationLocationCount: 2,
      },
      {
        fragmentId: SECOND_FRAGMENT,
        fragmentIdx: 1,
        activationSectionId: "section-2",
        label: "Chapter two",
        charCount: 8,
        navigationLocationCount: 1,
      },
    ]);

    const relabeled = createEpubFindSnapshot({
      mediaId: MEDIA_ID,
      fragments: [
        { fragment_id: FIRST_FRAGMENT, fragment_idx: 0, char_count: 12 },
        { fragment_id: SECOND_FRAGMENT, fragment_idx: 1, char_count: 8 },
      ],
      navigation: [
        navigationSection({ label: "Relabeled chapter" }),
        navigationSection({
          section_id: "section-1-2",
          label: "Relabeled heading",
          ordinal: 1,
        }),
        navigationSection({
          section_id: "section-2",
          label: "Relabeled second chapter",
          ordinal: 2,
          fragment_id: SECOND_FRAGMENT,
          fragment_idx: 1,
        }),
      ],
    });
    expect(relabeled.sourceKey).toBe(snapshot.sourceKey);
  });

  it("defects on missing or contradictory canonical navigation facts", () => {
    expect(() =>
      createEpubFindSnapshot({
        mediaId: MEDIA_ID,
        fragments: [],
        navigation: [],
      }),
    ).toThrow(/no canonical fragments/);
    expect(() =>
      createEpubFindSnapshot({
        mediaId: MEDIA_ID,
        fragments: [
          { fragment_id: FIRST_FRAGMENT, fragment_idx: 0, char_count: 12 },
        ],
        navigation: [
          navigationSection(),
          navigationSection({
            section_id: "section-2",
            ordinal: 1,
            fragment_idx: 1,
          }),
        ],
      }),
    ).toThrow(/contradictory/);
  });
});

describe("EPUB Find wire decoding", () => {
  it("strictly decodes Ready and section responses", () => {
    expect(decodeEpubFindResult(readyResponse())).toEqual(
      readyResponse().data,
    );
    expect(decodeEpubSectionContent(sectionResponse())).toEqual(
      sectionResponse().data,
    );
  });

  it("rejects variant extras, malformed ranges, and the wrong cap", () => {
    expect(() =>
      decodeEpubFindResult({
        data: {
          kind: "NoMatches",
          source_witness_fragment_id: FIRST_FRAGMENT,
          occurrences: [],
        },
      }),
    ).toThrow(/exactly/);
    const malformed = readyResponse();
    malformed.data.occurrences[0]!.end_offset = 1;
    expect(() => decodeEpubFindResult(malformed)).toThrow(/right-open/);
    expect(() =>
      decodeEpubFindResult({
        data: {
          kind: "TooManyMatches",
          source_witness_fragment_id: FIRST_FRAGMENT,
          threshold: 2001,
        },
      }),
    ).toThrow(/2000/);
  });
});

describe("EPUB Find requests", () => {
  it("posts the exact query and decodes the response", async () => {
    const fetchFn = vi.fn(async () => readyResponse());
    const request = {
      source_witness_fragment_id: FIRST_FRAGMENT,
      query: "find",
      match_case: false,
      whole_word: true,
      scope: { kind: "EntireResource" as const },
    };

    await expect(
      requestEpubFind({
        mediaId: MEDIA_ID,
        request,
        signal: new AbortController().signal,
        fetchFn,
      }),
    ).resolves.toEqual(readyResponse().data);
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/media/${MEDIA_ID}/epub-find`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(request),
      }),
    );
  });

  it("path-encodes section ids and strictly decodes the section", async () => {
    const fetchFn = vi.fn(async () => sectionResponse());
    await expect(
      requestEpubSection({
        mediaId: MEDIA_ID,
        sectionId: "OPS/chapter 1",
        signal: new AbortController().signal,
        fetchFn,
      }),
    ).resolves.toEqual(sectionResponse().data);
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/media/${MEDIA_ID}/sections/OPS%2Fchapter%201`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
