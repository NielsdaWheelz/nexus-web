import { describe, expect, it } from "vitest";
import { Link2 } from "lucide-react";
import { RESOURCE_SCHEMES } from "@/lib/resourceGraph/resourceRef";
import { resourceIconForScheme, resourceIconForUri } from "./resourceKind";

describe("resourceKind", () => {
  it("has a specific icon for every resource scheme", () => {
    for (const scheme of RESOURCE_SCHEMES) {
      expect(resourceIconForScheme(scheme)).not.toBe(Link2);
    }
  });

  it("uses the fallback icon for unknown schemes and malformed refs", () => {
    expect(resourceIconForScheme("unknown")).toBe(Link2);
    expect(
      resourceIconForUri("unknown:11111111-1111-4111-8111-111111111111"),
    ).toBe(Link2);
    expect(resourceIconForUri("not-a-ref")).toBe(Link2);
  });

  it("treats user graph tags as unknown at runtime", () => {
    expect(resourceIconForScheme("tag")).toBe(Link2);
    expect(resourceIconForUri("tag:11111111-1111-4111-8111-111111111111")).toBe(
      Link2,
    );
  });
});
