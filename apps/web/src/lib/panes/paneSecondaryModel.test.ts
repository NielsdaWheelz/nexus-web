import { describe, expect, it } from "vitest";
import {
  getSecondaryGroupForSurface,
  getSecondaryGroupDefinition,
  getSecondarySurfaceDefinition,
  getSecondarySurfaceIdsForGroup,
  getSecondaryWidthPolicy,
  isWorkspaceSecondaryGroupId,
  isWorkspaceSecondarySurfaceId,
  paneSecondaryRegionId,
  resolveEffectiveSecondarySizing,
  PANE_SECONDARY_SURFACE_DEFINITIONS,
} from "@/lib/panes/paneSecondaryModel";

describe("paneSecondaryModel", () => {
  it("scopes the Inspector region id by primary pane", () => {
    expect(paneSecondaryRegionId("pane-a", "resource-inspector")).toBe(
      "pane-pane-a-secondary-resource-inspector",
    );
    expect(paneSecondaryRegionId("pane-b", "resource-inspector")).not.toBe(
      paneSecondaryRegionId("pane-a", "resource-inspector"),
    );
  });
  it("maps secondary surfaces to their owning groups", () => {
    expect(getSecondaryGroupForSurface("resource-contents")).toBe("resource-inspector");
    expect(getSecondaryGroupForSurface("resource-evidence")).toBe("resource-inspector");
    expect(getSecondaryGroupForSurface("resource-context")).toBe(
      "resource-inspector",
    );
    expect(getSecondaryGroupForSurface("resource-forks")).toBe(
      "resource-inspector",
    );
  });

  it("owns surface metadata in one place", () => {
    expect(getSecondaryGroupDefinition("resource-inspector").title).toBe("Companion");
    expect(getSecondarySurfaceDefinition("resource-contents")).toMatchObject({
      groupId: "resource-inspector",
      title: "Contents",
      iconId: "list-tree",
    });
    expect(getSecondarySurfaceDefinition("resource-evidence")).toMatchObject({
      groupId: "resource-inspector",
      title: "Evidence",
      iconId: "link-2",
    });
    expect(getSecondarySurfaceDefinition("resource-forks")).toMatchObject({
      groupId: "resource-inspector",
      title: "Forks",
      iconId: "git-branch",
    });
    expect(getSecondarySurfaceIdsForGroup("resource-inspector")).toEqual([
      "resource-contents",
      "resource-evidence",
      "resource-context",
      "resource-connections",
      "resource-forks",
      "resource-dossier",
    ]);
  });

  it("validates secondary ids", () => {
    expect(isWorkspaceSecondarySurfaceId("resource-evidence")).toBe(true);
    expect(isWorkspaceSecondarySurfaceId("unknown")).toBe(false);
    expect(isWorkspaceSecondaryGroupId("resource-inspector")).toBe(true);
    expect(isWorkspaceSecondaryGroupId("unknown")).toBe(false);
  });

  it("clamps secondary width to the group policy", () => {
    const policy = getSecondaryWidthPolicy("resource-inspector");

    expect(
      resolveEffectiveSecondarySizing({ storedWidthPx: 100, policy }),
    ).toMatchObject({
      widthPx: 280,
      minWidthPx: 280,
      maxWidthPx: 720,
      storedWidthCorrectionPx: 280,
    });
    expect(
      resolveEffectiveSecondarySizing({ storedWidthPx: 640, policy }),
    ).toMatchObject({
      widthPx: 640,
      storedWidthCorrectionPx: null,
    });
    expect(
      resolveEffectiveSecondarySizing({ storedWidthPx: Number.NaN, policy }),
    ).toMatchObject({
      widthPx: 360,
      storedWidthCorrectionPx: null,
    });
  });

  it("resource-inspector owns exactly the six canonical surfaces", () => {
    const inspectorSurfaces = PANE_SECONDARY_SURFACE_DEFINITIONS.filter(
      (d) => d.groupId === "resource-inspector",
    );
    expect(inspectorSurfaces.map((d) => d.id)).toEqual([
      "resource-contents",
      "resource-evidence",
      "resource-context",
      "resource-connections",
      "resource-forks",
      "resource-dossier",
    ]);
  });
});
