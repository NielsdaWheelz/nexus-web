import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DossierSurface from "@/components/dossier/DossierSurface";
import { absent, present } from "@/lib/api/presence";
import type { DossierControllerStore } from "@/lib/dossiers/dossierControllerStore";
import {
  initialDossierControllerState,
  type DossierControllerState,
} from "@/lib/dossiers/dossierControllerTypes";

function readyMediaState(): DossierControllerState {
  return {
    ...initialDossierControllerState(),
    head: {
      kind: "Ready",
      ready: {
        artifactId: present("artifact-1"),
        artifactRef: present("artifact:artifact-1"),
        currentRevision: present({
          artifactId: "artifact-1",
          artifactRef: "artifact:artifact-1",
          revisionId: "revision-1",
          revisionRef: "artifact_revision:revision-1",
          isCurrent: true,
          contentMd: "# Canonical dossier",
          citations: [],
          inputManifest: {
            version: "v1",
            kind: "media",
            mediaRef: "media:media-1",
            contentFingerprint: "fingerprint-1",
            offeredClaimCount: 3,
            omittedEvidenceRefs: ["evidence_span:evidence-1"],
          },
          instruction: present("Focus on the central evidence."),
          creatorUserId: present("user-1"),
          modelProvider: present("openai"),
          modelName: present("gpt-5"),
          totalTokens: present(1234),
          createdAt: "2026-07-23T12:00:00Z",
          promotedAt: absent(),
        }),
        freshness: present("Current"),
        activeBuild: absent(),
        latestUnsuccessfulBuild: absent(),
        revisionCount: 1,
        mediaAbstract: present({
          kind: "Ready",
          summaryMd: "A compact abstract.",
        }),
        history: [],
        historyStatus: "idle",
      },
    },
  };
}

function storeFor(state: DossierControllerState): DossierControllerStore {
  return {
    subscribe: () => () => {},
    getSnapshot: () => state,
    attach: vi.fn(),
    detach: vi.fn(),
    refreshHead: vi.fn(),
    loadHistory: vi.fn(),
    generate: vi.fn(),
    regenerate: vi.fn(),
    retry: vi.fn(),
    cancel: vi.fn(),
    makeCurrent: vi.fn(),
    selectHistorical: vi.fn(),
    selectCurrent: vi.fn(),
    setInstructionDraft: vi.fn(),
    resetRevisionSelection: vi.fn(),
    dispose: vi.fn(),
  };
}

describe("DossierSurface", () => {
  it("exposes the Media Abstract above the canonical dossier with coverage and provenance", () => {
    const store = storeFor(readyMediaState());
    const onViewMediaEvidence = vi.fn();
    render(
      <DossierSurface
        store={store}
        onViewMediaEvidence={onViewMediaEvidence}
      />,
    );

    const abstract = screen.getByRole("region", { name: "Media abstract" });
    const dossier = screen.getByRole("heading", { name: "Canonical dossier" });
    expect(
      abstract.compareDocumentPosition(dossier) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("A compact abstract.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "View evidence" }));
    expect(onViewMediaEvidence).toHaveBeenCalledOnce();

    expect(screen.getByLabelText("Dossier coverage")).toHaveTextContent(
      "3 claims offered · 1 evidence item omitted",
    );
    expect(screen.getByLabelText("Dossier provenance")).toHaveTextContent(
      "Creator user-1 · openai · gpt-5 · 1,234 tokens · 2026-07-23T12:00:00Z",
    );
    expect(screen.getByLabelText("Dossier instruction")).toHaveTextContent(
      "Focus on the central evidence.",
    );
  });

  it("sends the workspace-retained optional instruction when regenerating", () => {
    const state = {
      ...readyMediaState(),
      instructionDraft: "Emphasize the disputed evidence.",
    };
    const store = storeFor(state);
    render(<DossierSurface store={store} onViewMediaEvidence={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));

    expect(store.regenerate).toHaveBeenCalledWith(
      "Emphasize the disputed evidence.",
    );
  });

  it("uses one polite live region while revision history is loading", () => {
    const state = readyMediaState();
    if (state.head.kind !== "Ready") throw new Error("expected ready head");
    state.head.ready.revisionCount = 2;
    state.head.ready.historyStatus = "loading";
    state.stream = "Terminal";
    state.progressMessage = "Dossier generated.";
    const store = storeFor(state);

    render(<DossierSurface store={store} onViewMediaEvidence={vi.fn()} />);

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Dossier generated.");
    expect(screen.getByText("Loading revision history…")).not.toHaveAttribute(
      "role",
    );
  });

  it("exposes an accessible revision-history retry", () => {
    const state = readyMediaState();
    if (state.head.kind !== "Ready") throw new Error("expected ready head");
    state.head.ready.revisionCount = 2;
    state.head.ready.historyStatus = "failed";
    const store = storeFor(state);

    render(<DossierSurface store={store} onViewMediaEvidence={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Revision history is unavailable.",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Retry revision history" }),
    );
    expect(store.loadHistory).toHaveBeenCalledOnce();
  });
});
