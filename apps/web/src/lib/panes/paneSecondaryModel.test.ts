import { describe, expect, it } from "vitest";
import {
  getSecondaryGroupForSurface,
  getSecondarySurfaceDefinition,
  getSecondarySurfaceIdsForGroup,
  getSecondaryWidthPolicy,
  isWorkspaceSecondaryGroupId,
  isWorkspaceSecondarySurfaceId,
  resolveEffectiveSecondarySizing,
} from "@/lib/panes/paneSecondaryModel";

describe("paneSecondaryModel", () => {
  it("maps secondary surfaces to their owning groups", () => {
    expect(getSecondaryGroupForSurface("reader-highlights")).toBe("reader-tools");
    expect(getSecondaryGroupForSurface("reader-doc-chat")).toBe("reader-tools");
    expect(getSecondaryGroupForSurface("reader-contents")).toBe("reader-tools");
    expect(getSecondaryGroupForSurface("conversation-references")).toBe(
      "conversation-context",
    );
    expect(getSecondaryGroupForSurface("conversation-forks")).toBe(
      "conversation-context",
    );
    expect(getSecondaryGroupForSurface("library-intelligence")).toBe("library-tools");
  });

  it("owns surface metadata in one place", () => {
    expect(getSecondarySurfaceDefinition("reader-contents")).toMatchObject({
      groupId: "reader-tools",
      title: "Contents",
      iconId: "list-tree",
    });
    expect(getSecondarySurfaceDefinition("conversation-forks")).toMatchObject({
      groupId: "conversation-context",
      title: "Forks",
      iconId: "git-branch",
    });
    expect(getSecondarySurfaceIdsForGroup("reader-tools")).toEqual([
      "reader-highlights",
      "reader-doc-chat",
      "reader-contents",
    ]);
    expect(getSecondarySurfaceIdsForGroup("conversation-context")).toEqual([
      "conversation-references",
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
});
