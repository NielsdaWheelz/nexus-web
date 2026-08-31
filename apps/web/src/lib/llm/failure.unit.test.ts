import { describe, expect, it } from "vitest";
import type { ExpectedChatFailure } from "@/lib/conversations/types";
import { decodeExpectedChatFailure } from "@/lib/conversations/chatFailureContract";
import { chatFailureMessage } from "./failure";

const FAILURE_FIXTURES = [
  { code: "cancelled", can_rerun: true },
  { code: "context_too_large", can_rerun: false },
  { code: "invalid_output", can_rerun: false },
  { code: "incomplete", can_rerun: true },
  { code: "assistant_unavailable", can_rerun: true },
  { code: "operator_defect", can_rerun: false },
] as const satisfies readonly ExpectedChatFailure[];

describe("ExpectedChatFailure", () => {
  it("keeps the browser fixture at the six-code, two-field wire contract", () => {
    expect(FAILURE_FIXTURES.map((failure) => failure.code)).toEqual([
      "cancelled",
      "context_too_large",
      "invalid_output",
      "incomplete",
      "assistant_unavailable",
      "operator_defect",
    ]);
    for (const failure of FAILURE_FIXTURES) {
      expect(Object.keys(failure).sort()).toEqual(["can_rerun", "code"]);
    }
  });

  it("provides exhaustive copy for every closed variant", () => {
    for (const failure of FAILURE_FIXTURES) {
      const copy = chatFailureMessage(failure);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body.length).toBeGreaterThan(0);
    }
    expect(chatFailureMessage(null)).toEqual({
      title: "Something went wrong",
      body: "This response couldn't be completed. Please try again in a new message.",
    });
  });

  it("strictly decodes only the current two-field failure union", () => {
    for (const failure of FAILURE_FIXTURES) {
      expect(decodeExpectedChatFailure(failure)).toEqual(failure);
    }
    expect(() =>
      decodeExpectedChatFailure({
        code: "assistant_unavailable",
        can_rerun: true,
        attempts: 3,
      }),
    ).toThrow("must contain exactly");
    expect(() =>
      decodeExpectedChatFailure({ code: "provider_error", can_rerun: true }),
    ).toThrow("must be one of");
    expect(() =>
      decodeExpectedChatFailure({
        code: "operator_defect",
        can_rerun: true,
      }),
    ).toThrow("must have can_rerun=false");
  });

  it("fails closed if unvalidated runtime data reaches the copy mapper", () => {
    expect(() =>
      chatFailureMessage({
        code: "provider_error",
        can_rerun: true,
      } as unknown as ExpectedChatFailure),
    ).toThrow('Unsupported chat failure code: "provider_error"');
  });
});
