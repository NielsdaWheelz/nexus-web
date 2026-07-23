import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import {
  DOSSIER_API_ERROR_CODES,
  dossierApiErrorMessage,
  isDossierApiErrorCode,
} from "@/lib/dossiers/dossierErrorMessage";

describe("dossier API error copy", () => {
  it("owns a closed copy mapping for every expected Dossier API error", () => {
    expect(DOSSIER_API_ERROR_CODES).toEqual([
      "E_DOSSIER_GENERATION_IN_PROGRESS",
      "E_DOSSIER_BUILD_NOT_ACTIVE",
      "E_DOSSIER_NOT_FOUND",
      "E_DOSSIER_REVISION_NOT_FOUND",
      "E_DOSSIER_INVALID_SUBJECT",
      "E_DOSSIER_INVALID_INSTRUCTION",
    ]);
    for (const code of DOSSIER_API_ERROR_CODES) {
      expect(isDossierApiErrorCode(code)).toBe(true);
      expect(
        dossierApiErrorMessage(new ApiError(400, code, "backend fallback")),
      ).not.toBe("backend fallback");
    }
  });

  it("does not mistake unrelated API errors for the closed Dossier union", () => {
    expect(isDossierApiErrorCode("E_INTERNAL")).toBe(false);
    expect(
      dossierApiErrorMessage(
        new ApiError(500, "E_INTERNAL", "Cancellation service unavailable."),
      ),
    ).toBe("Cancellation service unavailable.");
  });
});
