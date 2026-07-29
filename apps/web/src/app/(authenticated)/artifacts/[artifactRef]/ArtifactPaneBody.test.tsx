import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
}));

const storeMocks = vi.hoisted(() => ({
  selectHistorical: vi.fn(),
  selectCurrent: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("@/components/dossier/DossierSurface", () => ({
  default: () => <div data-testid="dossier-surface" />,
}));

vi.mock("@/components/workspace/PanePrimaryChrome", () => ({
  usePanePrimaryChrome: vi.fn(),
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
          identity: {
            kind: "Present",
            value: { kind: "Idea", title: "Entropy" },
          },
        },
      },
    }),
}));

vi.mock("@/lib/panes/paneRuntime", () => ({
  requirePaneRuntime: (runtime: unknown) => runtime,
  usePaneParam: () => ARTIFACT_REF,
  usePaneReturnReady: vi.fn(),
  usePaneRouter: () => ({ replace: paneMocks.replace }),
  usePaneRuntime: () => ({ activateTarget: paneMocks.activateTarget }),
  usePaneSearchParams: () =>
    new URLSearchParams(
      paneMocks.revisionRef === null
        ? ""
        : `revision=${encodeURIComponent(paneMocks.revisionRef)}`,
    ),
  useSetPaneLabel: vi.fn(),
}));

describe("ArtifactPaneBody revision query", () => {
  beforeEach(() => {
    paneMocks.revisionRef = REVISION_REF;
    paneMocks.replace.mockReset();
    paneMocks.activateTarget.mockReset();
    storeMocks.selectHistorical.mockReset();
    storeMocks.selectCurrent.mockReset();
    storeMocks.dispose.mockReset();
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
});
