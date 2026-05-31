import { describe, expect, it } from "vitest";
import { Link2 } from "lucide-react";
import {
  RESOURCE_URI_SCHEMES,
  parseResourceUri,
  resourceIconForScheme,
  resourceIconForUri,
  resourceObjectTypeForScheme,
} from "./resourceKind";

describe("resourceKind", () => {
  it("parses canonical resource URIs", () => {
    expect(parseResourceUri("media:11111111-1111-4111-8111-111111111111")).toEqual({
      scheme: "media",
      id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("rejects malformed, noncanonical, and unsupported resource URIs", () => {
    expect(parseResourceUri("media")).toBeNull();
    expect(parseResourceUri("media:")).toBeNull();
    expect(parseResourceUri("unknown:11111111-1111-4111-8111-111111111111")).toBeNull();
    expect(parseResourceUri("media:11111111-1111-4111-8111-111111111111:extra")).toBeNull();
    expect(parseResourceUri("media:11111111-1111-4111-8111-11111111111Z")).toBeNull();
    expect(parseResourceUri("media:11111111-1111-4111-8111-111111111111".toUpperCase())).toBeNull();
  });

  it("has a specific icon for every resolver-backed URI scheme", () => {
    for (const scheme of RESOURCE_URI_SCHEMES) {
      expect(resourceIconForScheme(scheme)).not.toBe(Link2);
    }
  });

  it("uses the fallback icon for unknown schemes", () => {
    expect(resourceIconForScheme("unknown")).toBe(Link2);
    expect(resourceIconForUri("unknown:11111111-1111-4111-8111-111111111111")).toBe(Link2);
  });

  it("maps openable resource schemes to object-ref types", () => {
    expect(resourceObjectTypeForScheme("media")).toBe("media");
    expect(resourceObjectTypeForScheme("span")).toBe("evidence_span");
    expect(resourceObjectTypeForScheme("chunk")).toBe("content_chunk");
    expect(resourceObjectTypeForScheme("library")).toBeNull();
  });
});
