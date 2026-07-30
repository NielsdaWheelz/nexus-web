import { describe, expect, it, vi } from "vitest";
import type {
  DossierDocumentFindCapability,
  DossierDocumentFindResult,
} from "@/components/dossier/DossierDocumentFrame";
import { present } from "@/lib/api/presence";
import { createPaneFindSourceKey } from "@/lib/panes/paneSearch";
import { createArtifactPaneFindAdapter } from "./artifactPaneFind";

const ARTIFACT_REF = "artifact:artifact-1";

function capability(): DossierDocumentFindCapability {
  return {
    revisionRef: "artifact_revision:revision-1",
    setFindEnabled: vi.fn(),
    prepare: vi.fn(async () => ({
      projectionLengthCp: 100,
      currentSection: present({ id: "why", title: "Why it matters" }),
    })),
    find: vi.fn<DossierDocumentFindCapability["find"]>(async () => ({
      kind: "Ready",
      occurrences: [
        {
          ordinal: 0,
          startCp: 12,
          endCp: 18,
          snippet: [
            { text: "Before ", emphasized: false },
            { text: "needle", emphasized: true },
          ],
          section: present({ id: "why", title: "Why it matters" }),
        },
      ],
    })),
    activate: vi.fn<DossierDocumentFindCapability["activate"]>(
      async ({ ordinal }) => ({
        kind: "Activated",
        ordinal,
      }),
    ),
    clear: vi.fn(async () => {}),
    returnToReadingPosition: vi.fn<
      DossierDocumentFindCapability["returnToReadingPosition"]
    >(async () => ({ kind: "Returned" })),
  };
}

describe("Artifact pane Find adapter", () => {
  it("maps the exact frame revision, current section, rows, and activation", async () => {
    const owner = capability();
    const adapter = createArtifactPaneFindAdapter(ARTIFACT_REF, owner);
    expect(adapter.sourceKey).toContain(ARTIFACT_REF);
    expect(adapter.sourceKey).toContain(owner.revisionRef);
    expect(adapter.sourceKey).toContain('"kind":"DossierRevision"');
    const signal = new AbortController().signal;
    const session = await adapter.prepare({
      sessionId: 1,
      sourceKey: adapter.sourceKey,
      signal,
    });
    expect(session.scopes).toEqual([
      { kind: "EntireResource", id: "all", label: "Entire dossier" },
      { kind: "Narrow", id: "current", label: "This section" },
    ]);

    const response = await adapter.find({
      sessionId: 1,
      queryId: 1,
      sourceKey: adapter.sourceKey,
      signal,
      query: "needle",
      scopeId: "current",
      matchCase: true,
      wholeWord: true,
    });
    expect(owner.find).toHaveBeenCalledWith({
      sessionId: 1,
      queryId: 1,
      signal,
      query: "needle",
      scope: { kind: "CurrentSection", sectionId: "why" },
      matchCase: true,
      wholeWord: true,
    });
    expect(response).toMatchObject({
      kind: "Ready",
      completeness: "Complete",
      rows: [
        {
          context: ["Why it matters"],
          snippet: [
            { text: "Before ", emphasized: false },
            { text: "needle", emphasized: true },
          ],
        },
      ],
    });
    if (response.kind !== "Ready") {
      throw new Error("Expected Artifact Find rows.");
    }
    expect(response.rows[0]!.key).toContain(
      '"locator":{"endCp":18,"kind":"ArtifactRange","startCp":12}',
    );
    expect(response.rows[0]!.key).toContain('"kind":"DossierRevision"');

    await expect(
      adapter.preview({
        sessionId: 1,
        queryId: 1,
        sourceKey: adapter.sourceKey,
        signal,
        key: response.rows[0]!.key,
      }),
    ).resolves.toMatchObject({ kind: "Previewed" });
    expect(owner.activate).toHaveBeenCalledWith({
      sessionId: 1,
      queryId: 1,
      ordinal: 0,
      signal,
    });

    await adapter.clearPresentation({
      sessionId: 1,
      sourceKey: adapter.sourceKey,
      signal,
    });
    expect(owner.clear).toHaveBeenCalledWith({
      sessionId: 1,
      queryId: 1,
      signal,
    });
  });

  it("closes origin unavailability as preview failure", async () => {
    const owner = capability();
    vi.mocked(owner.activate).mockResolvedValue({
      kind: "Rejected",
      reason: "OriginUnavailable",
    });
    const adapter = createArtifactPaneFindAdapter(ARTIFACT_REF, owner);
    const signal = new AbortController().signal;
    await adapter.prepare({
      sessionId: 1,
      sourceKey: adapter.sourceKey,
      signal,
    });
    const response = await adapter.find({
      sessionId: 1,
      queryId: 1,
      sourceKey: adapter.sourceKey,
      signal,
      query: "needle",
      scopeId: "all",
      matchCase: false,
      wholeWord: false,
    });
    if (response.kind !== "Ready") {
      throw new Error("Expected Artifact Find rows.");
    }

    await expect(
      adapter.preview({
        sessionId: 1,
        queryId: 1,
        sourceKey: adapter.sourceKey,
        signal,
        key: response.rows[0]!.key,
      }),
    ).resolves.toMatchObject({
      kind: "Rejected",
      error: { kind: "OriginUnavailable" },
    });
  });

  it("keeps newer result identities when an older query settles late", async () => {
    let settleFirst:
      | ((result: DossierDocumentFindResult) => void)
      | undefined;
    const owner = capability();
    vi.mocked(owner.find)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settleFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        kind: "Ready",
        occurrences: [
          {
            ordinal: 0,
            startCp: 30,
            endCp: 36,
            snippet: [{ text: "newest", emphasized: true }],
            section: present({ id: "why", title: "Why it matters" }),
          },
        ],
      });
    const adapter = createArtifactPaneFindAdapter(ARTIFACT_REF, owner);
    const signal = new AbortController().signal;
    await adapter.prepare({
      sessionId: 1,
      sourceKey: adapter.sourceKey,
      signal,
    });
    const first = adapter.find({
      sessionId: 1,
      queryId: 1,
      sourceKey: adapter.sourceKey,
      signal,
      query: "old",
      scopeId: "all",
      matchCase: false,
      wholeWord: false,
    });
    const second = await adapter.find({
      sessionId: 1,
      queryId: 2,
      sourceKey: adapter.sourceKey,
      signal,
      query: "new",
      scopeId: "all",
      matchCase: false,
      wholeWord: false,
    });
    if (second.kind !== "Ready") {
      throw new Error("Expected newer Artifact Find rows.");
    }
    settleFirst?.({
      kind: "Ready",
      occurrences: [
        {
          ordinal: 0,
          startCp: 1,
          endCp: 4,
          snippet: [{ text: "old", emphasized: true }],
          section: present({ id: "old", title: "Old section" }),
        },
      ],
    });
    await first;

    await expect(
      adapter.preview({
        sessionId: 1,
        queryId: 2,
        sourceKey: adapter.sourceKey,
        signal,
        key: second.rows[0]!.key,
      }),
    ).resolves.toMatchObject({ kind: "Previewed" });
  });

  it("defects when Return cannot restore the immutable origin", async () => {
    const owner = capability();
    vi.mocked(owner.returnToReadingPosition).mockResolvedValue({
      kind: "Rejected",
      reason: "OriginUnavailable",
    });
    const adapter = createArtifactPaneFindAdapter(ARTIFACT_REF, owner);
    const signal = new AbortController().signal;
    await adapter.prepare({
      sessionId: 1,
      sourceKey: adapter.sourceKey,
      signal,
    });

    await expect(
      adapter.returnToReadingPosition({
        sessionId: 1,
        sourceKey: adapter.sourceKey,
        signal,
      }),
    ).rejects.toThrow("Artifact Find reading origin is unavailable.");
  });

  it("rejects requests for another source identity", async () => {
    const owner = capability();
    const adapter = createArtifactPaneFindAdapter(ARTIFACT_REF, owner);
    const staleSourceKey = createPaneFindSourceKey({
      kind: "DossierRevision",
      artifactRef: ARTIFACT_REF,
      revisionRef: "artifact_revision:revision-2",
    });

    await expect(
      adapter.prepare({
        sessionId: 1,
        sourceKey: staleSourceKey,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Artifact Find prepare source identity is stale.");
    expect(
      adapter.errorMessage({ kind: "OriginUnavailable" }),
    ).toBe("The reading position could not be captured.");
  });
});
