import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DossierDocumentFindCapability } from "@/components/dossier/DossierDocumentFrame";
import { present } from "@/lib/api/presence";
import type { PaneSecondaryPublication } from "@/lib/panes/panePublications";
import type {
  PaneFindOccurrencesPublication,
  PaneSearchPublication,
} from "@/lib/panes/paneSearch";
import ArtifactPaneBody from "./ArtifactPaneBody";

const ARTIFACT_REF = "artifact:11111111-1111-4111-8111-111111111111";
const REVISION_REF =
  "artifact_revision:22222222-2222-4222-8222-222222222222";

const paneMocks = vi.hoisted(() => ({
  revisionRef:
    "artifact_revision:22222222-2222-4222-8222-222222222222" as
      | string
      | null,
  replace: vi.fn(),
  activateTarget: vi.fn(),
  isActive: true,
  transientSecondarySurface: null as {
    id: "resource-search";
    expanded: boolean;
  } | null,
  requestTransientSecondarySurface: vi.fn(),
  closeTransientSecondarySurface: vi.fn(),
  previewTransientSecondaryResult: vi.fn(),
}));

const storeMocks = vi.hoisted(() => ({
  selectHistorical: vi.fn(),
  selectCurrent: vi.fn(),
  dispose: vi.fn(),
}));

const publicationMocks = vi.hoisted(() => ({
  primary: null as { search?: PaneSearchPublication } | null,
  secondary: null as PaneSecondaryPublication | null,
}));

const surfaceMocks = vi.hoisted(() => ({
  props: null as {
    onFindCapabilityChange: (
      capability: DossierDocumentFindCapability | null,
    ) => void;
    onFindRequested: () => void;
  } | null,
}));

const searchEventMocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
}));

vi.mock("@/components/dossier/DossierSurface", () => ({
  default: (props: NonNullable<typeof surfaceMocks.props>) => {
    surfaceMocks.props = props;
    return <div data-testid="dossier-surface" />;
  },
}));

vi.mock("@/components/workspace/PanePrimaryChrome", () => ({
  usePanePrimaryChrome: (
    publication: typeof publicationMocks.primary,
  ) => {
    publicationMocks.primary = publication;
  },
}));

vi.mock("@/components/workspace/PaneSecondary", () => ({
  usePaneSecondary: (publication: PaneSecondaryPublication | null) => {
    publicationMocks.secondary = publication;
  },
}));

vi.mock("@/lib/panes/paneSearchEvents", () => ({
  dispatchPaneSearchRequest: searchEventMocks.dispatch,
}));

vi.mock("@/lib/dossiers/dossierControllerStore", () => ({
  createDossierControllerStore: () => ({
    selectHistorical: storeMocks.selectHistorical,
    selectCurrent: storeMocks.selectCurrent,
    dispose: storeMocks.dispose,
  }),
  useDossierSelector: (
    _store: unknown,
    selector: (snapshot: unknown) => unknown,
  ) =>
    selector({
      head: {
        kind: "Ready",
        ready: {
          currentRevision: {
            kind: "Present",
            value: { revisionRef: REVISION_REF },
          },
          identity: {
            kind: "Present",
            value: { kind: "Idea", title: "Entropy" },
          },
        },
      },
      revisionSelection: { kind: "Current" },
      historicalRevision: { kind: "Idle" },
    }),
}));

vi.mock("@/lib/panes/paneRuntime", () => ({
  requirePaneRuntime: (runtime: unknown) => runtime,
  usePaneParam: () => ARTIFACT_REF,
  usePaneReturnDescendantReady: vi.fn(),
  usePaneReturnReady: vi.fn(),
  usePaneRouter: () => ({ replace: paneMocks.replace }),
  usePaneRuntime: () => ({
    paneId: "pane-1",
    routeKey: `artifact:${ARTIFACT_REF}`,
    isActive: paneMocks.isActive,
    activateTarget: paneMocks.activateTarget,
    transientSecondarySurface: paneMocks.transientSecondarySurface,
    requestTransientSecondarySurface:
      paneMocks.requestTransientSecondarySurface,
    closeTransientSecondarySurface:
      paneMocks.closeTransientSecondarySurface,
    previewTransientSecondaryResult:
      paneMocks.previewTransientSecondaryResult,
  }),
  usePaneSearchParams: () =>
    new URLSearchParams(
      paneMocks.revisionRef === null
        ? ""
        : `revision=${encodeURIComponent(paneMocks.revisionRef)}`,
    ),
  useSetPaneLabel: vi.fn(),
}));

function findCapability(): DossierDocumentFindCapability {
  return {
    revisionRef: REVISION_REF,
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
          startCp: 10,
          endCp: 16,
          snippet: [{ text: "needle", emphasized: true }],
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

function currentFindPublication(): PaneFindOccurrencesPublication {
  const search = publicationMocks.primary?.search;
  if (search?.kind !== "FindOccurrences") {
    throw new Error("Expected Artifact Find publication.");
  }
  return search;
}

describe("ArtifactPaneBody revision query", () => {
  beforeEach(() => {
    paneMocks.revisionRef = REVISION_REF;
    paneMocks.replace.mockReset();
    paneMocks.activateTarget.mockReset();
    paneMocks.isActive = true;
    paneMocks.transientSecondarySurface = null;
    paneMocks.requestTransientSecondarySurface.mockReset();
    paneMocks.closeTransientSecondarySurface.mockReset();
    paneMocks.previewTransientSecondaryResult.mockReset();
    storeMocks.selectHistorical.mockReset();
    storeMocks.selectCurrent.mockReset();
    storeMocks.dispose.mockReset();
    publicationMocks.primary = null;
    publicationMocks.secondary = null;
    surfaceMocks.props = null;
    searchEventMocks.dispatch.mockReset();
  });

  it("projects revision query changes into the one Artifact controller", async () => {
    const view = render(<ArtifactPaneBody />);

    await waitFor(() => {
      expect(storeMocks.selectHistorical).toHaveBeenCalledWith(REVISION_REF);
    });
    expect(storeMocks.selectCurrent).not.toHaveBeenCalled();

    paneMocks.revisionRef = null;
    view.rerender(<ArtifactPaneBody />);

    await waitFor(() => {
      expect(storeMocks.selectCurrent).toHaveBeenCalledOnce();
    });
  });

  it("publishes exact-revision Find and transient-only results, then disables before removal", async () => {
    const capability = findCapability();
    const view = render(<ArtifactPaneBody />);
    expect(publicationMocks.primary?.search).toBeUndefined();
    expect(publicationMocks.secondary).toBeNull();

    const staleCapability = {
      ...findCapability(),
      revisionRef: "artifact_revision:stale",
    };
    act(() => {
      surfaceMocks.props?.onFindCapabilityChange(staleCapability);
    });
    expect(publicationMocks.primary?.search).toBeUndefined();
    expect(staleCapability.setFindEnabled).not.toHaveBeenCalled();

    act(() => {
      surfaceMocks.props?.onFindCapabilityChange(capability);
    });
    await waitFor(() =>
      expect(publicationMocks.primary?.search?.kind).toBe("FindOccurrences"),
    );
    expect(capability.setFindEnabled).toHaveBeenCalledWith(true);
    expect(publicationMocks.secondary).toMatchObject({
      groupId: "resource-inspector",
      surfaces: [],
      defaultSurfaceId: null,
      transientSurfaces: [{ id: "resource-search" }],
    });

    const search = publicationMocks.primary?.search;
    if (search?.kind !== "FindOccurrences") {
      throw new Error("Expected Artifact Find publication.");
    }
    const trigger = document.createElement("button");
    act(() => search.onShowResults(trigger));
    expect(
      paneMocks.requestTransientSecondarySurface,
    ).toHaveBeenCalledWith("resource-search", { returnFocusTo: trigger });
    paneMocks.closeTransientSecondarySurface.mockClear();
    paneMocks.transientSecondarySurface = {
      id: "resource-search",
      expanded: true,
    };
    view.rerender(<ArtifactPaneBody />);
    expect(paneMocks.closeTransientSecondarySurface).not.toHaveBeenCalled();
    expect(
      publicationMocks.primary?.search?.kind === "FindOccurrences"
        ? publicationMocks.primary.search.resultsExpanded
        : false,
    ).toBe(true);

    act(() => {
      surfaceMocks.props?.onFindRequested();
    });
    expect(searchEventMocks.dispatch).toHaveBeenCalledOnce();

    paneMocks.isActive = false;
    view.rerender(<ArtifactPaneBody />);
    expect(capability.setFindEnabled).toHaveBeenLastCalledWith(false);
    act(() => {
      surfaceMocks.props?.onFindRequested();
    });
    expect(searchEventMocks.dispatch).toHaveBeenCalledOnce();

    paneMocks.isActive = true;
    view.rerender(<ArtifactPaneBody />);
    await waitFor(() =>
      expect(capability.setFindEnabled).toHaveBeenLastCalledWith(true),
    );
    act(() => {
      surfaceMocks.props?.onFindCapabilityChange(null);
    });
    expect(capability.setFindEnabled).toHaveBeenLastCalledWith(false);
    expect(publicationMocks.primary?.search).toBeUndefined();
    expect(publicationMocks.secondary).toBeNull();
  });

  it("previews frame results without creating a durable Companion tab", async () => {
    const capability = findCapability();
    render(<ArtifactPaneBody />);
    act(() => {
      surfaceMocks.props?.onFindCapabilityChange(capability);
    });
    await waitFor(() =>
      expect(publicationMocks.primary?.search?.kind).toBe("FindOccurrences"),
    );
    let search = currentFindPublication();

    act(() => search.onQueryChange("needle"));
    await waitFor(() => {
      search = currentFindPublication();
      expect(search.result.kind).toBe("Ready");
    });
    if (search.result.kind !== "Ready") {
      throw new Error("Expected Artifact Find results.");
    }
    const key = search.result.rows[0]!.key;
    act(() => search.onActivate(key));
    await waitFor(() =>
      expect(paneMocks.previewTransientSecondaryResult).toHaveBeenCalled(),
    );
    expect(capability.activate).toHaveBeenCalledWith(
      expect.objectContaining({ ordinal: 0 }),
    );
    expect(publicationMocks.secondary?.surfaces).toEqual([]);
    expect(publicationMocks.secondary?.defaultSurfaceId).toBeNull();

    act(() => search.onDismiss());
    expect(paneMocks.closeTransientSecondarySurface).toHaveBeenCalled();
    await waitFor(() => {
      const current = publicationMocks.primary?.search;
      expect(
        current?.kind === "FindOccurrences"
          ? current.returnToReadingPosition.kind
          : "Unavailable",
      ).toBe("Available");
    });
  });

  it("retains Return when Close aborts an already-dispatched first activation", async () => {
    let settleActivation: (() => void) | null = null;
    const capability = findCapability();
    vi.mocked(capability.activate).mockImplementation(
      ({ ordinal }) =>
        new Promise((resolve) => {
          settleActivation = () => resolve({ kind: "Activated", ordinal });
        }),
    );
    render(<ArtifactPaneBody />);
    act(() => {
      surfaceMocks.props?.onFindCapabilityChange(capability);
    });
    await waitFor(() =>
      expect(publicationMocks.primary?.search?.kind).toBe("FindOccurrences"),
    );
    let search = currentFindPublication();
    act(() => search.onQueryChange("needle"));
    await waitFor(() => expect(settleActivation).not.toBeNull());
    expect(capability.prepare).toHaveBeenCalledTimes(1);

    act(() => {
      search.onDismiss();
      search.onOpen();
    });
    expect(capability.prepare).toHaveBeenCalledTimes(1);
    await act(async () => {
      settleActivation?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      search = currentFindPublication();
      expect(search.returnToReadingPosition.kind).toBe("Available");
    });
    expect(capability.prepare).toHaveBeenCalledTimes(1);
  });
});
