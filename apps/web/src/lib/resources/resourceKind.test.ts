import { describe, expect, it } from "vitest";
import { Link2 } from "lucide-react";
import { RESOURCE_SCHEMES } from "@/lib/resourceGraph/resourceRef";
import {
  resourceIconForScheme,
  resourceIconForUri,
  resourceObjectTypeForScheme,
} from "./resourceKind";

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

  it("maps linkable resource schemes to object-ref types", () => {
    expect(resourceObjectTypeForScheme("media")).toBe("media");
    expect(resourceObjectTypeForScheme("library")).toBe("library");
    expect(resourceObjectTypeForScheme("evidence_span")).toBe("evidence_span");
    expect(resourceObjectTypeForScheme("content_chunk")).toBe("content_chunk");
    expect(resourceObjectTypeForScheme("oracle_reading")).toBe(
      "oracle_reading",
    );
    expect(resourceObjectTypeForScheme("library_intelligence_revision")).toBe(
      "library_intelligence_revision",
    );
    expect(resourceObjectTypeForScheme("oracle_corpus_passage")).toBeNull();
    expect(resourceObjectTypeForScheme("external_snapshot")).toBeNull();
  });

  it("treats user graph tags as unknown at runtime", () => {
    expect(resourceIconForScheme("tag")).toBe(Link2);
    expect(resourceIconForUri("tag:11111111-1111-4111-8111-111111111111")).toBe(
      Link2,
    );
  });
});
