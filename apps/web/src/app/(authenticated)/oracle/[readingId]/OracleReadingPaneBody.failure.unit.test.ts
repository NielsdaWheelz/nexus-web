import { describe, expect, it } from "vitest";
import {
  oracleFailureFeedback,
  type OracleGenerationFailureCode,
} from "./OracleReadingPaneBody";
import {
  HISTORICAL_ORACLE_READING_FAILURE_CODES,
  ORACLE_READING_FAILURE_CODES,
} from "@/lib/oracle/oracleReadingWire";

const SUPPORTED_CODES = [
  ...ORACLE_READING_FAILURE_CODES,
  ...HISTORICAL_ORACLE_READING_FAILURE_CODES,
] as const satisfies readonly OracleGenerationFailureCode[];

describe("Oracle generation failure feedback", () => {
  it("covers current and explicitly migration-tagged failure codes", () => {
    for (const code of SUPPORTED_CODES) {
      expect(oracleFailureFeedback(code)).toMatchObject({ tone: "Danger" });
    }
  });

  it("defects when a failed reading has no decoded terminal code", () => {
    expect(() => oracleFailureFeedback(null)).toThrow(
      "Failed Oracle reading has no terminal error code",
    );
  });
});
