import { render, waitFor } from "@testing-library/react";
import type {
  ComponentProps,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaneSecondaryContext } from "@/components/workspace/PaneSecondary";
import {
  PaneRuntimeProvider,
  type PaneRuntimeLayoutPublication,
} from "@/lib/panes/paneRuntime";
import type { WorkspaceDossierActivation } from "@/lib/panes/paneSecondaryModel";
import { initialDossierControllerState } from "@/lib/dossiers/dossierControllerTypes";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import type { DossierCitationActivate } from "@/components/dossier/DossierSurface";
import type { PaneSecondaryPublication } from "@/lib/panes/panePublications";
import type { ResourceItem } from "@/lib/resources/resourceItems";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import { assumePaneVisitId } from "@/lib/workspace/schema";

const TEST_VISIT_ID = assumePaneVisitId(
  "00000000-0000-4000-8000-000000000001",
);

const controller = vi.hoisted(() => ({
  subscribe: vi.fn(() => () => undefined),
  getSnapshot: vi.fn(),
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
}));
const dispatchReaderSourceActivation = vi.hoisted(() => vi.fn());

vi.mock("@/lib/dossiers/dossierControllerStore", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/dossiers/dossierControllerStore")
  >("@/lib/dossiers/dossierControllerStore");
  return {
    ...actual,
    createDossierControllerStore: vi.fn(() => controller),
  };
});
vi.mock("@/lib/conversations/readerSourceActivation", () => ({
  dispatchReaderSourceActivation,
}));

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_HREF = `/media/${MEDIA_ID}`;

function InspectorOwner() {
  useResourceInspector({
    scheme: "media",
    handle: MEDIA_ID,
    bodies: { linkedItems: <div>Evidence</div> },
  });
  return null;
}

function InspectorVisibilityHarness({
  visibility,
  activeSurfaceId,
}: {
  visibility: "visible" | "collapsed";
  activeSurfaceId: "resource-dossier" | "resource-evidence";
}) {
  return (
    <PaneRuntimeProvider
      paneId="pane-1"
      visitId={TEST_VISIT_ID}
      isActive
      href={MEDIA_HREF}
      routeId="media"
      routeKey={`media:${MEDIA_HREF}`}
      secondaryPane={{
        id: "secondary-1",
        parentPrimaryPaneId: "pane-1",
        groupId: "resource-inspector",
        activeSurfaceId,
        widthPx: 360,
        visibility,
      }}
      secondaryActivation={null}
      canGoBack={false}
      canGoForward={false}
      onNavigatePane={vi.fn()}
      onReplacePane={vi.fn()}
      onOpenInNewPane={vi.fn()}
      onGoBackPane={vi.fn()}
      onGoForwardPane={vi.fn()}
      onSetPaneLayout={vi.fn<(input: PaneRuntimeLayoutPublication) => void>()}
      onAcknowledgeSecondaryActivation={vi.fn()}
    >
      <PaneSecondaryContext.Provider value={vi.fn()}>
        <InspectorOwner />
      </PaneSecondaryContext.Provider>
    </PaneRuntimeProvider>
  );
}

function renderInspector(
  secondaryActivation: WorkspaceDossierActivation | null,
  options: {
    resourceItem?: ResourceItem;
    onNavigatePane?: ComponentProps<
      typeof PaneRuntimeProvider
    >["onNavigatePane"];
    onOpenInNewPane?: ComponentProps<
      typeof PaneRuntimeProvider
    >["onOpenInNewPane"];
    onRequestSecondarySurface?: ComponentProps<
      typeof PaneRuntimeProvider
    >["onRequestSecondarySurface"];
  } = {},
) {
  const acknowledge = vi.fn();
  const publishSecondary = vi.fn();
  render(
    <PaneRuntimeProvider
      paneId="pane-1"
      visitId={TEST_VISIT_ID}
      isActive
      href={MEDIA_HREF}
      routeId="media"
      routeKey={`media:${MEDIA_HREF}`}
      resourceItem={options.resourceItem}
      secondaryPane={{
        id: "secondary-1",
        parentPrimaryPaneId: "pane-1",
        groupId: "resource-inspector",
        activeSurfaceId: "resource-dossier",
        widthPx: 360,
        visibility: "visible",
      }}
      secondaryActivation={secondaryActivation}
      canGoBack={false}
      canGoForward={false}
      onNavigatePane={options.onNavigatePane ?? vi.fn()}
      onReplacePane={vi.fn()}
      onOpenInNewPane={options.onOpenInNewPane ?? vi.fn()}
      onGoBackPane={vi.fn()}
      onGoForwardPane={vi.fn()}
      onSetPaneLayout={vi.fn<(input: PaneRuntimeLayoutPublication) => void>()}
      onRequestSecondarySurface={options.onRequestSecondarySurface}
      onAcknowledgeSecondaryActivation={acknowledge}
    >
      <PaneSecondaryContext.Provider value={publishSecondary}>
        <InspectorOwner />
      </PaneSecondaryContext.Provider>
    </PaneRuntimeProvider>,
  );
  return { acknowledge, publishSecondary };
}

function dossierBodyProps(
  publishSecondary: ReturnType<typeof vi.fn>,
): {
  onCitationActivate: DossierCitationActivate;
  onViewMediaEvidence: () => void;
} {
  const publication = publishSecondary.mock.calls
    .map(([value]) => value as PaneSecondaryPublication | null)
    .find((value) => value !== null);
  const dossier = publication?.surfaces.find(
    (surface) => surface.id === "resource-dossier",
  );
  const body = dossier?.body as ReactElement<{
    onCitationActivate: DossierCitationActivate;
    onViewMediaEvidence: () => void;
  }>;
  return body.props;
}

function dossierCitationActivate(
  publishSecondary: ReturnType<typeof vi.fn>,
): DossierCitationActivate {
  return dossierBodyProps(publishSecondary).onCitationActivate;
}

function mediaResourceItem(): ResourceItem {
  return {
    ref: `media:${MEDIA_ID}`,
    scheme: "media",
    id: MEDIA_ID,
    label: "Media",
    summary: "",
    route: MEDIA_HREF,
    activation: {
      resourceRef: `media:${MEDIA_ID}`,
      kind: "route",
      href: MEDIA_HREF,
      unresolvedReason: null,
    },
    missing: false,
    capabilities: {} as ResourceItem["capabilities"],
    versionByLane: {},
  };
}

describe("useResourceInspector workspace activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controller.getSnapshot.mockReturnValue(initialDossierControllerState());
  });

  it("opens an artifact head on the canonical current Dossier", async () => {
    const activation = {
      kind: "DossierCurrent",
      surfaceId: "resource-dossier",
    } as const;
    const { acknowledge } = renderInspector(activation);

    await waitFor(() => {
      expect(controller.selectCurrent).toHaveBeenCalledOnce();
      expect(acknowledge).toHaveBeenCalledWith(
        "pane-1",
        `media:${MEDIA_HREF}`,
        activation,
      );
    });
    expect(controller.selectHistorical).not.toHaveBeenCalled();
    expect(controller.resetRevisionSelection).not.toHaveBeenCalled();
  });

  it("selects and acknowledges an exact artifact revision locally", async () => {
    const activation = {
      kind: "DossierRevision",
      surfaceId: "resource-dossier",
      revisionRef:
        "artifact_revision:22222222-2222-4222-8222-222222222222",
    } as const;
    const { acknowledge } = renderInspector(activation);

    await waitFor(() => {
      expect(controller.selectHistorical).toHaveBeenCalledWith(
        activation.revisionRef,
      );
      expect(acknowledge).toHaveBeenCalledWith(
        "pane-1",
        `media:${MEDIA_HREF}`,
        activation,
      );
    });
    expect(controller.resetRevisionSelection).not.toHaveBeenCalled();
  });

  it("opens a Dossier citation on its exact artifact revision through the pane runtime", async () => {
    const onOpenInNewPane =
      vi.fn<ComponentProps<typeof PaneRuntimeProvider>["onOpenInNewPane"]>();
    const revisionRef =
      "artifact_revision:33333333-3333-4333-8333-333333333333";
    const { publishSecondary } = renderInspector(null, { onOpenInNewPane });

    await waitFor(() => {
      expect(publishSecondary).toHaveBeenCalled();
    });
    dossierCitationActivate(publishSecondary)(
      {
        resourceRef: revisionRef,
        kind: "route",
        href: "/conversations/44444444-4444-4444-8444-444444444444",
        unresolvedReason: null,
      },
      null,
    );

    expect(onOpenInNewPane).toHaveBeenCalledWith(
      "/conversations/44444444-4444-4444-8444-444444444444",
      undefined,
      {
        kind: "DossierRevision",
        surfaceId: "resource-dossier",
        revisionRef,
      },
      "Programmatic",
    );
  });

  it("pulses a same-resource target without navigating away", async () => {
    const onNavigatePane =
      vi.fn<ComponentProps<typeof PaneRuntimeProvider>["onNavigatePane"]>();
    const onOpenInNewPane =
      vi.fn<ComponentProps<typeof PaneRuntimeProvider>["onOpenInNewPane"]>();
    const target: ReaderSourceTarget = {
      kind: "media",
      source: "message_retrieval",
      media_id: MEDIA_ID,
      locator: {
        type: "pdf_page_geometry",
        media_id: MEDIA_ID,
        page_number: 3,
        quads: [],
        exact: "Evidence",
      },
      snippet: "Evidence",
      highlight_behavior: "pulse",
      focus_behavior: "scroll_into_view",
      label: "Evidence",
    };
    const { publishSecondary } = renderInspector(null, {
      resourceItem: mediaResourceItem(),
      onNavigatePane,
      onOpenInNewPane,
    });

    await waitFor(() => {
      expect(publishSecondary).toHaveBeenCalled();
    });
    dossierCitationActivate(publishSecondary)(
      {
        resourceRef:
          "content_chunk:66666666-6666-4666-8666-666666666666",
        kind: "route",
        href: MEDIA_HREF,
        unresolvedReason: null,
      },
      target,
    );

    expect(dispatchReaderSourceActivation).toHaveBeenCalledWith(target);
    expect(onNavigatePane).not.toHaveBeenCalled();
    expect(onOpenInNewPane).not.toHaveBeenCalled();
  });

  it("preserves Shift activation as a sibling-pane open", async () => {
    const onNavigatePane =
      vi.fn<ComponentProps<typeof PaneRuntimeProvider>["onNavigatePane"]>();
    const onOpenInNewPane =
      vi.fn<ComponentProps<typeof PaneRuntimeProvider>["onOpenInNewPane"]>();
    const href = "/pages/55555555-5555-4555-8555-555555555555";
    const { publishSecondary } = renderInspector(null, {
      onNavigatePane,
      onOpenInNewPane,
    });

    await waitFor(() => {
      expect(publishSecondary).toHaveBeenCalled();
    });
    dossierCitationActivate(publishSecondary)(
      {
        resourceRef: "page:55555555-5555-4555-8555-555555555555",
        kind: "route",
        href,
        unresolvedReason: null,
      },
      null,
      { shiftKey: true } as ReactMouseEvent,
    );

    expect(onOpenInNewPane).toHaveBeenCalledWith(
      href,
      undefined,
      undefined,
      "Programmatic",
    );
    expect(onNavigatePane).not.toHaveBeenCalled();
  });

  it("routes Media Abstract evidence through the shared inspector surface command", async () => {
    const onRequestSecondarySurface =
      vi.fn<
        NonNullable<
          ComponentProps<
            typeof PaneRuntimeProvider
          >["onRequestSecondarySurface"]
        >
      >();
    const { publishSecondary } = renderInspector(null, {
      onRequestSecondarySurface,
    });

    await waitFor(() => {
      expect(publishSecondary).toHaveBeenCalled();
    });
    dossierBodyProps(publishSecondary).onViewMediaEvidence();

    expect(onRequestSecondarySurface).toHaveBeenCalledWith(
      "pane-1",
      "resource-evidence",
      undefined,
    );
  });

  it("retains revision selection across tab switches and resets it only after close/reopen", async () => {
    const view = render(
      <InspectorVisibilityHarness
        visibility="visible"
        activeSurfaceId="resource-dossier"
      />,
    );
    await waitFor(() =>
      expect(controller.resetRevisionSelection).toHaveBeenCalledOnce(),
    );

    view.rerender(
      <InspectorVisibilityHarness
        visibility="visible"
        activeSurfaceId="resource-evidence"
      />,
    );
    await waitFor(() =>
      expect(controller.resetRevisionSelection).toHaveBeenCalledOnce(),
    );

    view.rerender(
      <InspectorVisibilityHarness
        visibility="collapsed"
        activeSurfaceId="resource-evidence"
      />,
    );
    view.rerender(
      <InspectorVisibilityHarness
        visibility="visible"
        activeSurfaceId="resource-evidence"
      />,
    );
    await waitFor(() =>
      expect(controller.resetRevisionSelection).toHaveBeenCalledTimes(2),
    );
  });
});
