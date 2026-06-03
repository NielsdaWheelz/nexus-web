import { describe, expect, it } from "vitest";
import {
  buildOraclePlateImageSrc,
  isOraclePlateImageSrc,
  parseOraclePlateImageSrc,
  requireOraclePlateImageSrc,
} from "./oraclePlateImage";

describe("oracle plate image src", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  const src = `/api/oracle/plates/${id}`;

  it("builds and accepts backend Oracle plate URLs", () => {
    expect(buildOraclePlateImageSrc(id)).toBe(src);
    expect(isOraclePlateImageSrc(src)).toBe(true);
    expect(parseOraclePlateImageSrc(src)).toBe(src);
  });

  it("rejects arbitrary owned image paths", () => {
    expect(isOraclePlateImageSrc("/api/media/image?url=x")).toBe(false);
    expect(parseOraclePlateImageSrc("/api/oracle/plates/not-a-uuid")).toBeNull();
    expect(() => requireOraclePlateImageSrc("/api/oracle/plates/not-a-uuid")).toThrow(
      "Invalid Oracle plate image URL",
    );
  });
});
