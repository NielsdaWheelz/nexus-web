import { describe, expect, it } from "vitest";
import {
  oracleFailureFeedback,
  type OracleGenerationFailureCode,
} from "./OracleReadingPaneBody";

const SUPPORTED_CODES: readonly OracleGenerationFailureCode[] = [
  "auth",
  "quota",
  "timeout",
  "output_limit",
  "invalid_output",
  "policy_violation",
  "runtime_unavailable",
  "capacity_unavailable",
  "context_too_large",
  "defect",
  "E_ORACLE_CORPUS_NOT_READY",
  "E_APP_SEARCH_FAILED",
  "E_INTERNAL",
  "E_RATE_LIMITED",
];

describe("Oracle generation failure feedback", () => {
  it("covers the normalized terminal codes and Oracle/API failures", () => {
    for (const code of SUPPORTED_CODES) {
      expect(oracleFailureFeedback(code)).toMatchObject({ tone: "Danger" });
    }
  });

  it("rejects retired provider and token-budget vocabulary", () => {
    for (const code of [
      "invalid_structured_output",
      "budget_exceeded",
      "rate_limited",
      "provider_unavailable",
      "stream_interrupted",
      "E_TOKEN_BUDGET_EXCEEDED",
    ]) {
      expect(() => oracleFailureFeedback(code)).toThrow(
        "Unsupported oracle terminal error code",
      );
    }
  });
});
