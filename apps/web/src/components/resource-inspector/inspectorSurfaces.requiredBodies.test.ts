import { describe, expect, it } from "vitest";
import { planInspectorSurfaces } from "./inspectorSurfaces";

describe("planInspectorSurfaces required capability bodies", () => {
  it("defects instead of silently omitting a capability-required surface", () => {
    expect(() =>
      planInspectorSurfaces({
        policy: {
          linkedItems: "ResourceConnections",
          forks: null,
          defaultSurfaceOrder: ["Dossier"],
        },
        bodies: {},
        dossierBody: "Dossier",
      }),
    ).toThrow(/linked.?items/i);

    expect(() =>
      planInspectorSurfaces({
        policy: {
          linkedItems: "ConversationContext",
          forks: "ConversationForks",
          defaultSurfaceOrder: ["LinkedItems", "Forks", "Dossier"],
        },
        bodies: { linkedItems: "Context" },
        dossierBody: "Dossier",
      }),
    ).toThrow(/forks/i);
  });

  it("publishes optional Members before linked items without changing the default", () => {
    const plan = planInspectorSurfaces({
      policy: {
        linkedItems: "ResourceConnections",
        forks: null,
        defaultSurfaceOrder: ["Dossier"],
      },
      bodies: { members: "Members", linkedItems: "Connections" },
      dossierBody: "Dossier",
    });

    expect(plan.surfaces.map((surface) => surface.id)).toEqual([
      "resource-members",
      "resource-connections",
      "resource-dossier",
    ]);
    expect(plan.defaultSurfaceId).toBe("resource-dossier");
    expect(plan.transientSurfaces).toEqual([]);
  });

  it("composes Search results separately from durable Inspector tabs", () => {
    const plan = planInspectorSurfaces({
      policy: {
        linkedItems: "ResourceConnections",
        forks: null,
        defaultSurfaceOrder: ["Dossier"],
      },
      bodies: { linkedItems: "Connections" },
      dossierBody: "Dossier",
      searchResultsBody: "Matches",
    });

    expect(plan.surfaces.map((surface) => surface.id)).toEqual([
      "resource-connections",
      "resource-dossier",
    ]);
    expect(plan.transientSurfaces).toEqual([
      { id: "resource-search", body: "Matches" },
    ]);
    expect(plan.defaultSurfaceId).toBe("resource-dossier");
  });
});
