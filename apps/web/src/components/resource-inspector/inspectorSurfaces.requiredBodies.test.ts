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
});
