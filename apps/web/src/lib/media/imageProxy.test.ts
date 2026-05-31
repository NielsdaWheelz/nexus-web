import { describe, expect, it } from "vitest";
import { buildMediaImageProxySrc } from "./imageProxy";

describe("buildMediaImageProxySrc", () => {
  it("encodes remote image URLs for the media image proxy", () => {
    expect(
      buildMediaImageProxySrc("https://cdn.example.com/covers/show art.jpg?size=large"),
    ).toBe(
      "/api/media/image?url=https%3A%2F%2Fcdn.example.com%2Fcovers%2Fshow%20art.jpg%3Fsize%3Dlarge",
    );
  });

  it("encodes already-local paths instead of treating them as proxy routes", () => {
    expect(buildMediaImageProxySrc("/api/media/image")).toBe(
      "/api/media/image?url=%2Fapi%2Fmedia%2Fimage",
    );
  });
});
