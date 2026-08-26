import { describe, expect, it } from "vitest";
import { decodeWalknoteTranscriptionResponse } from "@/lib/walknotes/transcribeAudio";

describe("Walknote transcription response", () => {
  it("decodes the exact success envelope", () => {
    expect(
      decodeWalknoteTranscriptionResponse({
        data: { transcript: "A remembered thought.", duration_ms: 1_250 },
      }),
    ).toBe("A remembered thought.");
  });

  it("rejects omitted, additive, and malformed response fields", () => {
    expect(() =>
      decodeWalknoteTranscriptionResponse({
        data: { transcript: "Thought", duration_ms: 1, confidence: 0.9 },
      }),
    ).toThrow(/exactly/);
    expect(() =>
      decodeWalknoteTranscriptionResponse({ data: { transcript: "Thought" } }),
    ).toThrow(/exactly/);
    expect(() =>
      decodeWalknoteTranscriptionResponse({
        data: { transcript: "Thought", duration_ms: -1 },
      }),
    ).toThrow(/nonnegative/);
  });
});
