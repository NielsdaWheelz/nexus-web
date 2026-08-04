import { expect, it } from "vitest";
import type { Fragment } from "@/lib/media/transcriptView";
import { createMediaFindPreviewLease } from "@/app/(authenticated)/media/[id]/mediaFindPreviewLease";
import {
  createWebFindAdapter,
  createWebFindSnapshot,
} from "@/app/(authenticated)/media/[id]/useMediaPaneFind";
import sharedCases from "../../../../../testdata/pane-find/canonical-text.json";

it("keeps web-pane Find aligned with the canonical text corpus", async () => {
  for (const [caseIndex, testCase] of sharedCases.cases.entries()) {
    const fragments: Fragment[] = testCase.units.map((unit, unitIndex) => ({
      id: unit.id,
      media_id: "media-corpus",
      idx: unitIndex,
      html_sanitized: "",
      canonical_text: unit.text.repeat("repeat" in unit ? unit.repeat : 1),
      document_embeds: [],
      created_at: `2026-07-31T12:${String(unitIndex).padStart(2, "0")}:00.000Z`,
    }));
    const snapshot = createWebFindSnapshot({
      mediaId: "media-corpus",
      fragments,
      sections: [],
    });
    const adapter = createWebFindAdapter({
      snapshot,
      getCurrentSourceKey: () => snapshot.sourceKey,
      getRenderedState: () => null,
      showPreviewFragment: async () => {
        throw new Error("Corpus matching must not move the rendered reader.");
      },
      clearPreviewFragment: () => {},
      focusReaderViewport: () => {},
      previewLease: createMediaFindPreviewLease(),
      presentation: { publish: () => {}, clear: () => {} },
      scrollPositioner: {
        async run() {
          throw new Error(
            "Corpus matching must not scroll the rendered reader.",
          );
        },
      },
    });
    const sessionId = caseIndex + 1;
    const signal = new AbortController().signal;
    await adapter.prepare({
      sessionId,
      sourceKey: snapshot.sourceKey,
      signal,
    });

    const result = await adapter.find({
      sessionId,
      queryId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
      query: testCase.query,
      scopeId: "EntireArticle",
      matchCase: testCase.matchCase,
      wholeWord: testCase.wholeWord,
    });

    expect(result.kind, testCase.name).toBe(testCase.expected.kind);
    if (result.kind === "Ready") {
      if (!("occurrences" in testCase.expected)) {
        throw new Error(`${testCase.name} requires Ready occurrences.`);
      }
      expect(
        result.rows.map((row) => {
          const parsed = JSON.parse(row.key) as {
            locator: {
              fragmentId: string;
              startCp: number;
              endCp: number;
            };
          };
          return {
            unitId: parsed.locator.fragmentId,
            startCp: parsed.locator.startCp,
            endCp: parsed.locator.endCp,
            snippet: row.snippet,
          };
        }),
        testCase.name,
      ).toEqual(testCase.expected.occurrences);
    } else if (result.kind === "TooManyMatches") {
      if (!("threshold" in testCase.expected)) {
        throw new Error(`${testCase.name} requires a match threshold.`);
      }
      expect(result.threshold, testCase.name).toBe(testCase.expected.threshold);
    }
    adapter.dispose();
  }
});
