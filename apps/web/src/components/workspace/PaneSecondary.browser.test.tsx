import { useRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";

import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import type { PaneSecondaryPublication } from "@/lib/panes/panePublications";
import type { WorkspaceSecondarySurfaceId } from "@/lib/panes/paneSecondaryModel";
import { PaneSecondaryContext, usePaneSecondary } from "./PaneSecondary";

const VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000001");
const MEDIA_HREF = "/media/11111111-1111-4111-8111-111111111111";
const noop = () => undefined;

// Before its outline loads a reader publishes Evidence + Dossier and defaults to
// Evidence; the loaded outline adds Contents and makes it the default.
const BEFORE_OUTLINE: PaneSecondaryPublication = {
  groupId: "resource-inspector",
  surfaces: [
    { id: "resource-evidence", body: null },
    { id: "resource-dossier", body: null },
  ],
  defaultSurfaceId: "resource-evidence",
};
const AFTER_OUTLINE: PaneSecondaryPublication = {
  groupId: "resource-inspector",
  surfaces: [
    { id: "resource-contents", body: null },
    { id: "resource-evidence", body: null },
    { id: "resource-dossier", body: null },
  ],
  defaultSurfaceId: "resource-contents",
};

function PaneBody({ outlineLoaded }: { outlineLoaded: boolean }) {
  const publication = outlineLoaded ? AFTER_OUTLINE : BEFORE_OUTLINE;
  const request = usePaneSecondary(publication);
  // The painted chrome keeps the command from the render that built it, while
  // the pane's open target follows the newest publication — exactly how
  // PaneShell's accepted primary-chrome record trails `useResourceInspector`.
  const paintedRequest = useRef(request);
  const openTarget = useRef<WorkspaceSecondarySurfaceId | null>(null);
  openTarget.current = publication.defaultSurfaceId;
  return (
    <button
      type="button"
      onClick={() => {
        if (openTarget.current) paintedRequest.current(openTarget.current);
      }}
    >
      Companion
    </button>
  );
}

function Harness({
  outlineLoaded,
  onRequest,
}: {
  outlineLoaded: boolean;
  onRequest: (surfaceId: WorkspaceSecondarySurfaceId) => void;
}) {
  return (
    <PaneRuntimeProvider
      paneId="pane-a"
      visitId={VISIT_ID}
      isActive
      href={MEDIA_HREF}
      routeId="media"
      canGoBack={false}
      canGoForward={false}
      onNavigatePane={noop}
      onReplacePane={noop}
      onActivateWorkspaceTarget={() => ({
        kind: "ActivatedExisting",
        paneId: "pane-a",
      })}
      onGoBackPane={noop}
      onGoForwardPane={noop}
      onRequestSecondarySurface={(_paneId, surfaceId) => onRequest(surfaceId)}
    >
      <PaneSecondaryContext.Provider value={noop}>
        <PaneBody outlineLoaded={outlineLoaded} />
      </PaneSecondaryContext.Provider>
    </PaneRuntimeProvider>
  );
}

it("opens the surface the pane targets now, not the one its painted publication knew", async () => {
  const requested: WorkspaceSecondarySurfaceId[] = [];
  const { rerender } = render(
    <Harness
      outlineLoaded={false}
      onRequest={(surfaceId) => requested.push(surfaceId)}
    />,
  );
  rerender(
    <Harness
      outlineLoaded
      onRequest={(surfaceId) => requested.push(surfaceId)}
    />,
  );

  await userEvent.click(screen.getByRole("button", { name: "Companion" }));

  expect(
    requested,
    "the Companion command was swallowed by the publication that painted it",
  ).toEqual(["resource-contents"]);
});
