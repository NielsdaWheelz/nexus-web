import { describe, expect, it } from "vitest";
import { planLabel } from "./planLabel";

describe("billing plan customer labels", () => {
  it("names transcription entitlements without implying general AI access", () => {
    expect(planLabel("free")).toBe("Free");
    expect(planLabel("plus")).toBe("Plus");
    expect(planLabel("ai_plus")).toBe("Transcription Plus");
    expect(planLabel("ai_pro")).toBe("Transcription Pro");
  });
});
