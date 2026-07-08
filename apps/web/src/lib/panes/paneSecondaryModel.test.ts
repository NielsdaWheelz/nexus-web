import { describe, expect, it } from "vitest";
import {
  getSecondaryGroupForSurface,
  getSecondaryGroupDefinition,
  getSecondarySurfaceDefinition,
  getSecondarySurfaceIdsForGroup,
  getSecondaryWidthPolicy,
  isWorkspaceSecondaryGroupId,
  isWorkspaceSecondarySurfaceId,
  resolveEffectiveSecondarySizing,
  PANE_SECONDARY_SURFACE_DEFINITIONS,
} from "@/lib/panes/paneSecondaryModel";

describe("paneSecondaryModel", () => {
  it("maps secondary surfaces to their owning groups", () => {
    expect(getSecondaryGroupForSurface("reader-contents")).toBe("reader-tools");
    expect(getSecondaryGroupForSurface("reader-evidence")).toBe("reader-tools");
    expect(getSecondaryGroupForSurface("conversation-context-refs")).toBe(
      "conversation-context",
    );
    expect(getSecondaryGroupForSurface("conversation-forks")).toBe(
      "conversation-context",
    );
    expect(getSecondaryGroupForSurface("library-intelligence")).toBe("library-tools");
  });

  it("owns surface metadata in one place", () => {
    expect(getSecondaryGroupDefinition("reader-tools").title).toBe("Document Map");
    expect(getSecondarySurfaceDefinition("reader-contents")).toMatchObject({
      groupId: "reader-tools",
      title: "Contents",
      iconId: "list-tree",
    });
    expect(getSecondarySurfaceDefinition("reader-evidence")).toMatchObject({
      groupId: "reader-tools",
      title: "Evidence",
      iconId: "link-2",
    });
    expect(getSecondarySurfaceDefinition("conversation-forks")).toMatchObject({
      groupId: "conversation-context",
      title: "Forks",
      iconId: "git-branch",
    });
    expect(getSecondarySurfaceIdsForGroup("reader-tools")).toEqual([
      "reader-contents",
      "reader-evidence",
    ]);
    expect(getSecondarySurfaceIdsForGroup("conversation-context")).toEqual([
      "conversation-context-refs",
      "conversation-forks",
    ]);
    expect(getSecondarySurfaceIdsForGroup("library-tools")).toEqual([
      "library-intelligence",
    ]);
  });

  it("validates secondary ids", () => {
    expect(isWorkspaceSecondarySurfaceId("library-chat")).toBe(false);
    expect(isWorkspaceSecondarySurfaceId("library-intelligence")).toBe(true);
    expect(isWorkspaceSecondarySurfaceId("unknown")).toBe(false);
    expect(isWorkspaceSecondaryGroupId("library-tools")).toBe(true);
    expect(isWorkspaceSecondaryGroupId("unknown")).toBe(false);
  });

  it("clamps secondary width to the group policy", () => {
    const policy = getSecondaryWidthPolicy("library-tools");

    expect(
      resolveEffectiveSecondarySizing({ storedWidthPx: 100, policy }),
    ).toMatchObject({
      widthPx: 320,
      minWidthPx: 320,
      maxWidthPx: 760,
      storedWidthCorrectionPx: 320,
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
      widthPx: 420,
      storedWidthCorrectionPx: null,
    });
  });

  it("does not include removed reader-tools surfaces", () => {
    const ids = PANE_SECONDARY_SURFACE_DEFINITIONS.map((d) => d.id);
    expect(ids).not.toContain("reader-highlights");
    expect(ids).not.toContain("reader-embeds");
    expect(ids).not.toContain("reader-apparatus");
    expect(ids).not.toContain("reader-connections");
    expect(ids).not.toContain("reader-resource-chat");
  });

  it("reader-tools has exactly two surfaces", () => {
    const readerTools = PANE_SECONDARY_SURFACE_DEFINITIONS.filter(
      (d) => d.groupId === "reader-tools",
    );
    expect(readerTools).toHaveLength(2);
    expect(readerTools.map((d) => d.id)).toEqual(
      expect.arrayContaining(["reader-contents", "reader-evidence"]),
    );
  });
});
