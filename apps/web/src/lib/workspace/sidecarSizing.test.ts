import { describe, expect, it } from "vitest";
import {
  getSidecarGroupForSurface,
  getSidecarWidthPolicy,
  isWorkspaceSidecarGroupId,
  isWorkspaceSidecarSurfaceId,
  resolveEffectiveSidecarSizing,
} from "@/lib/workspace/sidecarSizing";

describe("sidecar sizing", () => {
  it("maps sidecar surfaces to their owning groups", () => {
    expect(getSidecarGroupForSurface("reader-highlights")).toBe("reader-tools");
    expect(getSidecarGroupForSurface("reader-doc-chat")).toBe("reader-tools");
    expect(getSidecarGroupForSurface("conversation-references")).toBe(
      "conversation-context",
    );
    expect(getSidecarGroupForSurface("library-chat")).toBe("library-tools");
    expect(getSidecarGroupForSurface("library-intelligence")).toBe("library-tools");
  });

  it("validates sidecar ids", () => {
    expect(isWorkspaceSidecarSurfaceId("library-chat")).toBe(true);
    expect(isWorkspaceSidecarSurfaceId("unknown")).toBe(false);
    expect(isWorkspaceSidecarGroupId("library-tools")).toBe(true);
    expect(isWorkspaceSidecarGroupId("unknown")).toBe(false);
  });

  it("clamps sidecar width to the group policy", () => {
    const policy = getSidecarWidthPolicy("library-tools");

    expect(
      resolveEffectiveSidecarSizing({ storedWidthPx: 100, policy }),
    ).toMatchObject({
      widthPx: 320,
      minWidthPx: 320,
      maxWidthPx: 760,
      storedWidthCorrectionPx: 320,
    });
    expect(
      resolveEffectiveSidecarSizing({ storedWidthPx: 640, policy }),
    ).toMatchObject({
      widthPx: 640,
      storedWidthCorrectionPx: null,
    });
    expect(
      resolveEffectiveSidecarSizing({ storedWidthPx: Number.NaN, policy }),
    ).toMatchObject({
      widthPx: 420,
      storedWidthCorrectionPx: null,
    });
  });
});
