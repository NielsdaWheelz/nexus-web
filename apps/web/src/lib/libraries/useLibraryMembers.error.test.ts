import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import { libraryGovernanceErrorMessage } from "./useLibraryMembers";

describe("libraryGovernanceErrorMessage", () => {
  it("maps only structured expected API and network failures", () => {
    expect(
      libraryGovernanceErrorMessage(
        new ApiError(409, "E_CONFLICT", "conflict"),
        "Could not update members.",
      ),
    ).toMatchObject({ severity: "error" });
    expect(
      libraryGovernanceErrorMessage(
        new TypeError("offline"),
        "Could not update members.",
      ),
    ).toMatchObject({ title: "Could not update members." });
  });

  it("refuses same-system and unexpected defects", () => {
    expect(
      libraryGovernanceErrorMessage(
        new ApiError(500, "E_INVALID_RESPONSE", "malformed"),
        "Could not update members.",
      ),
    ).toBeNull();
    expect(
      libraryGovernanceErrorMessage(
        new Error("unexpected"),
        "Could not update members.",
      ),
    ).toBeNull();
  });
});
