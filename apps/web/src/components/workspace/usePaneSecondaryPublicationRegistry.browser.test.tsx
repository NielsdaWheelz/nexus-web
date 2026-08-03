import { act, render } from "@testing-library/react";
import { expect, it } from "vitest";

import { secondaryPublicationIncludesSurface } from "@/lib/panes/panePublications";
import { usePaneSecondaryPublicationRegistry } from "./usePaneSecondaryPublicationRegistry";

it("accepts the first valid Companion request in the publication commit", () => {
  let captured:
    | ReturnType<typeof usePaneSecondaryPublicationRegistry>
    | undefined;

  function Probe() {
    captured = usePaneSecondaryPublicationRegistry();
    return null;
  }

  render(<Probe />);
  if (!captured) throw new Error("Pane secondary publication registry did not mount.");
  const registry = captured;
  let acceptedInCommit = false;

  act(() => {
    registry.publish({
      paneId: "pane-1",
      routeKey: "conversation:one",
      publication: {
        groupId: "resource-inspector",
        surfaces: [{ id: "resource-evidence", body: null }],
        defaultSurfaceId: "resource-evidence",
      },
    });
    acceptedInCommit = secondaryPublicationIncludesSurface(
      registry.current("pane-1", "conversation:one"),
      "resource-evidence",
    );
  });

  expect(
    acceptedInCommit,
    "first Companion action was rejected before the publication render committed",
  ).toBe(true);
});
